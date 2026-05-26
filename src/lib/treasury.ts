/**
 * Treasury Reconciliation Engine
 *
 * Every N minutes (default 15) this runs and:
 *   1. Sums every account's balance in DynamoDB (ledger_total per currency)
 *   2. Fetches Zeeh's actual wallet balances from Expedier (expedier_balance)
 *   3. Computes variance = expedier_balance - ledger_total
 *      • Positive → Expedier has more than we owe (healthy)
 *      • Negative → WE OWE MORE THAN WE HOLD  ← fraud/bug, alert immediately
 *   4. Runs fraud-detection scans
 *   5. Writes a snapshot to zeeh-treasury-snapshots
 *
 * Status thresholds (per currency):
 *   ok       — variance >= -0.05 (rounding noise acceptable)
 *   warning  — variance < -0.05 and > -threshold (small shortfall, investigate)
 *   critical — variance < -threshold OR any fraud flag with severity 'critical'
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';
import { gtp } from './gtpClient';

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });
const db     = DynamoDBDocumentClient.from(dynamo);

const LEDGER_TABLE    = process.env.LEDGER_TABLE    ?? 'zeeh-client-ledger';
const TXN_TABLE       = process.env.TXN_TABLE       ?? 'zeeh-ledger-txns';
const DEPOSITS_TABLE  = process.env.DEPOSITS_TABLE  ?? 'zeeh-pending-deposits';
const SNAPSHOTS_TABLE = 'zeeh-treasury-snapshots';

// Shortfall larger than this triggers 'critical' (in any currency unit)
const CRITICAL_THRESHOLD = parseFloat(process.env.TREASURY_CRITICAL_THRESHOLD ?? '1.00');
const WARNING_THRESHOLD  = parseFloat(process.env.TREASURY_WARNING_THRESHOLD  ?? '0.05');

// ── Public types ─────────────────────────────────────────────────────────────

export interface CurrencyPosition {
  currency:          string;
  ledger_total:      string;   // sum of all DynamoDB balances
  expedier_balance:  string;   // actual GTP wallet balance ('N/A' if unavailable)
  variance:          string;   // expedier - ledger (negative = problem)
  variance_pct:      number;
  status:            'ok' | 'warning' | 'critical' | 'unknown';
  account_count:     number;
}

export interface FraudFlag {
  type:        string;
  severity:    'low' | 'medium' | 'high' | 'critical';
  currency?:   string;
  client_id?:  string;
  detail:      string;
  amount?:     string;
  detected_at: string;
}

export interface TreasurySnapshot {
  snapshot_id:         string;
  timestamp:           string;
  duration_ms:         number;
  triggered_by:        'scheduled' | 'manual';
  positions:           CurrencyPosition[];
  fraud_flags:         FraudFlag[];
  overall_status:      'ok' | 'warning' | 'critical';
  total_accounts:      number;
  expedier_available:  boolean;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Full paginated scan of zeeh-client-ledger — sums balances by currency */
async function scanLedgerTotals(): Promise<{
  byCurrency: Map<string, { total: number; count: number }>;
  negatives:  Array<{ client_id: string; currency: string; balance: string }>;
  total:      number;
}> {
  const byCurrency = new Map<string, { total: number; count: number }>();
  const negatives: Array<{ client_id: string; currency: string; balance: string }> = [];
  let accountCount = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await db.send(new ScanCommand({
      TableName: LEDGER_TABLE,
      ExclusiveStartKey: lastKey as Record<string, import('@aws-sdk/lib-dynamodb').NativeAttributeValue> | undefined,
      ProjectionExpression: 'client_id, currency, balance, available',
    }));

    for (const raw of (res.Items ?? [])) {
      const item = raw as { client_id: string; currency: string; balance: string; available: string };
      const bal  = parseFloat(item.balance ?? '0');
      if (bal === 0 && parseFloat(item.available ?? '0') === 0) continue; // skip zero rows

      accountCount++;
      const cur = item.currency?.toUpperCase();
      if (!cur) continue;

      const entry = byCurrency.get(cur) ?? { total: 0, count: 0 };
      entry.total  += bal;
      entry.count  += 1;
      byCurrency.set(cur, entry);

      if (bal < 0 || parseFloat(item.available ?? '0') < 0) {
        negatives.push({ client_id: item.client_id, currency: cur, balance: item.balance });
      }
    }

    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return { byCurrency, negatives, total: accountCount };
}

/** Fetch Zeeh's wallet balances from Expedier/GTP */
async function fetchExpedierBalances(): Promise<{ map: Map<string, number>; available: boolean }> {
  try {
    const { data } = await gtp.get('/wallets');
    const d = data.data;
    let wallets: Record<string, unknown>[] = [];
    if (Array.isArray(d))               wallets = d;
    else if (Array.isArray(d?.wallets)) wallets = d.wallets;
    else if (Array.isArray(data))        wallets = data;

    const map = new Map<string, number>();
    for (const w of wallets) {
      const cur = w.currency as Record<string, unknown> | string | undefined;
      const code = (typeof cur === 'object' && cur !== null)
        ? String((cur as Record<string, unknown>).code ?? '').toUpperCase()
        : String(cur ?? '').toUpperCase();
      if (!code || code === '[OBJECT OBJECT]') continue;

      // Try common balance field names
      const bal = parseFloat(
        String(w.balance ?? w.available_balance ?? w.ledger_balance ?? w.amount ?? '0')
      );
      if (!isNaN(bal)) map.set(code, (map.get(code) ?? 0) + bal);
    }
    return { map, available: true };
  } catch {
    return { map: new Map(), available: false };
  }
}

/** Scan recent transactions for fraud patterns */
async function detectFraudPatterns(
  negatives: Array<{ client_id: string; currency: string; balance: string }>
): Promise<FraudFlag[]> {
  const flags: FraudFlag[] = [];
  const now = new Date().toISOString();

  // ── 1. Negative balances — should be mathematically impossible ────────────
  for (const n of negatives) {
    flags.push({
      type:       'NEGATIVE_BALANCE',
      severity:   'critical',
      currency:   n.currency,
      client_id:  n.client_id,
      amount:     n.balance,
      detail:     `Account ${n.client_id} has negative ${n.currency} balance: ${n.balance}`,
      detected_at: now,
    });
  }

  // ── 2. Double-assigned deposits ───────────────────────────────────────────
  try {
    // Scan for deposit references that appear in more than one credit transaction
    // We look for the same credit_ref credited to multiple distinct client_ids
    const depRes = await db.send(new ScanCommand({
      TableName: DEPOSITS_TABLE,
      FilterExpression: '#s = :s',
      ExpressionAttributeNames:  { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'assigned' },
      ProjectionExpression: 'deposit_id, credit_ref, assigned_to, currency, amount',
    }));
    const assigned = (depRes.Items ?? []) as Array<{
      deposit_id: string; credit_ref: string; assigned_to: string; currency: string; amount: string;
    }>;

    // Group by credit_ref — if same ref assigned to multiple clients = fraud
    const refMap = new Map<string, typeof assigned>();
    for (const d of assigned) {
      if (!d.credit_ref) continue;
      const group = refMap.get(d.credit_ref) ?? [];
      group.push(d);
      refMap.set(d.credit_ref, group);
    }
    for (const [ref, group] of refMap) {
      if (group.length > 1) {
        flags.push({
          type:      'DOUBLE_ASSIGNED_DEPOSIT',
          severity:  'critical',
          detail:    `Deposit ref ${ref} credited to ${group.length} accounts: ${group.map(g => g.assigned_to).join(', ')}`,
          detected_at: now,
        });
      }
    }
  } catch { /* non-fatal */ }

  // ── 3. Large single credits in last 24h ───────────────────────────────────
  try {
    const LARGE_CREDIT_THRESHOLD = parseFloat(process.env.LARGE_CREDIT_THRESHOLD ?? '50000');
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Sample recent transactions across a few known high-volume accounts
    // (Full scan of txn table is expensive — we flag anomalies at assignment time instead)
    const txnRes = await db.send(new ScanCommand({
      TableName: TXN_TABLE,
      FilterExpression: 'direction = :d AND created_at > :since AND #a > :threshold',
      ExpressionAttributeNames:  { '#a': 'amount' },
      ExpressionAttributeValues: {
        ':d':         'credit',
        ':since':     since,
        ':threshold': String(LARGE_CREDIT_THRESHOLD),
      },
      ProjectionExpression: 'client_id, currency, amount, reference, created_at',
      Limit: 200,
    }));

    for (const raw of (txnRes.Items ?? [])) {
      const t = raw as { client_id: string; currency: string; amount: string; reference: string; created_at: string };
      flags.push({
        type:       'LARGE_CREDIT',
        severity:   'high',
        currency:   t.currency,
        client_id:  t.client_id,
        amount:     t.amount,
        detail:     `Large credit of ${t.currency} ${t.amount} to ${t.client_id} at ${t.created_at} (ref: ${t.reference})`,
        detected_at: now,
      });
    }
  } catch { /* non-fatal */ }

  // ── 4. Unassigned deposits older than 48h ─────────────────────────────────
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const oldRes = await db.send(new ScanCommand({
      TableName: DEPOSITS_TABLE,
      FilterExpression: '#s = :s AND created_at < :cutoff',
      ExpressionAttributeNames:  { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'unassigned', ':cutoff': cutoff },
      ProjectionExpression: 'deposit_id, currency, amount, created_at',
    }));
    const stale = (oldRes.Items ?? []) as Array<{ deposit_id: string; currency: string; amount: string; created_at: string }>;
    if (stale.length > 0) {
      const total = stale.reduce((s, d) => s + parseFloat(d.amount || '0'), 0);
      flags.push({
        type:     'STALE_UNASSIGNED_DEPOSITS',
        severity: 'medium',
        detail:   `${stale.length} deposit(s) unassigned for >48h, total ≈ ${total.toFixed(2)} across currencies`,
        detected_at: now,
      });
    }
  } catch { /* non-fatal */ }

  return flags;
}

// ── Main reconciliation function ─────────────────────────────────────────────

export async function runReconciliation(triggeredBy: 'scheduled' | 'manual' = 'scheduled'): Promise<TreasurySnapshot> {
  const start = Date.now();
  const snapshotId = `snap_${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(3).toString('hex')}`;

  // Run all checks in parallel
  const [ledgerData, expedierData] = await Promise.all([
    scanLedgerTotals(),
    fetchExpedierBalances(),
  ]);

  const fraudFlags = await detectFraudPatterns(ledgerData.negatives);

  // Build per-currency positions
  const allCurrencies = new Set([
    ...ledgerData.byCurrency.keys(),
    ...expedierData.map.keys(),
  ]);

  const positions: CurrencyPosition[] = [];

  for (const currency of allCurrencies) {
    const ledgerEntry    = ledgerData.byCurrency.get(currency) ?? { total: 0, count: 0 };
    const ledgerTotal    = ledgerEntry.total;
    const expedierBal    = expedierData.map.get(currency);
    const hasExpedier    = expedierBal !== undefined;
    const varianceNum    = hasExpedier ? expedierBal - ledgerTotal : 0;
    const variancePct    = ledgerTotal > 0 ? (varianceNum / ledgerTotal) * 100 : 0;

    let status: CurrencyPosition['status'] = 'unknown';
    if (hasExpedier) {
      if (varianceNum < -CRITICAL_THRESHOLD) {
        status = 'critical';
        fraudFlags.push({
          type:       'TREASURY_SHORTFALL',
          severity:   'critical',
          currency,
          detail:     `${currency} shortfall: Expedier has ${expedierBal?.toFixed(2)} but platform owes ${ledgerTotal.toFixed(2)} (gap: ${Math.abs(varianceNum).toFixed(2)})`,
          amount:     Math.abs(varianceNum).toFixed(2),
          detected_at: new Date().toISOString(),
        });
      } else if (varianceNum < -WARNING_THRESHOLD) {
        status = 'warning';
      } else {
        status = 'ok';
      }
    }

    positions.push({
      currency,
      ledger_total:     ledgerTotal.toFixed(2),
      expedier_balance: hasExpedier ? expedierBal!.toFixed(2) : 'N/A',
      variance:         hasExpedier ? varianceNum.toFixed(2) : 'N/A',
      variance_pct:     parseFloat(variancePct.toFixed(4)),
      status,
      account_count:    ledgerEntry.count,
    });
  }

  // Overall status = worst of all positions + fraud flags
  const hasCritical = positions.some(p => p.status === 'critical')
    || fraudFlags.some(f => f.severity === 'critical');
  const hasWarning  = positions.some(p => p.status === 'warning')
    || fraudFlags.some(f => f.severity === 'high');

  const overallStatus: TreasurySnapshot['overall_status'] =
    hasCritical ? 'critical' : hasWarning ? 'warning' : 'ok';

  const snapshot: TreasurySnapshot = {
    snapshot_id:        snapshotId,
    timestamp:          new Date().toISOString(),
    duration_ms:        Date.now() - start,
    triggered_by:       triggeredBy,
    positions:          positions.sort((a, b) => a.currency.localeCompare(b.currency)),
    fraud_flags:        fraudFlags,
    overall_status:     overallStatus,
    total_accounts:     ledgerData.total,
    expedier_available: expedierData.available,
  };

  await saveSnapshot(snapshot);

  if (overallStatus !== 'ok') {
    console.error(`\n${'█'.repeat(60)}`);
    console.error(`⚠️  TREASURY ALERT  [${snapshot.timestamp}]  status=${overallStatus.toUpperCase()}`);
    for (const f of fraudFlags) {
      console.error(`   [${f.severity.toUpperCase()}] ${f.type}: ${f.detail}`);
    }
    console.error(`${'█'.repeat(60)}\n`);
  } else {
    console.log(`✅  Treasury OK  [${snapshot.timestamp}]  accounts=${ledgerData.total}  duration=${snapshot.duration_ms}ms`);
  }

  return snapshot;
}

// ── Snapshot persistence ─────────────────────────────────────────────────────

export async function saveSnapshot(snapshot: TreasurySnapshot): Promise<void> {
  try {
    await db.send(new PutCommand({
      TableName: SNAPSHOTS_TABLE,
      Item: {
        ...snapshot,
        // Store as JSON string to avoid DynamoDB complexity with nested arrays
        positions:   JSON.stringify(snapshot.positions),
        fraud_flags: JSON.stringify(snapshot.fraud_flags),
        ttl:         Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, // 90-day retention
      },
    }));
  } catch (err) {
    console.error('Failed to save treasury snapshot:', err);
  }
}

export async function getSnapshots(limit = 20): Promise<TreasurySnapshot[]> {
  try {
    const res = await db.send(new ScanCommand({
      TableName: SNAPSHOTS_TABLE,
      Limit: limit * 3, // over-fetch because scan is unordered
    }));
    const items = ((res.Items ?? []) as Array<TreasurySnapshot & { positions: string; fraud_flags: string }>)
      .map(item => ({
        ...item,
        positions:   JSON.parse(item.positions  ?? '[]') as CurrencyPosition[],
        fraud_flags: JSON.parse(item.fraud_flags ?? '[]') as FraudFlag[],
      }))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
    return items;
  } catch {
    return [];
  }
}

export async function getLatestSnapshot(): Promise<TreasurySnapshot | null> {
  const snaps = await getSnapshots(1);
  return snaps[0] ?? null;
}
