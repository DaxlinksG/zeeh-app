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
import { sendTreasuryAlert } from './mailer';
import { freezeCurrency, unfreezeCurrency, listFrozen } from './circuitBreaker';

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

export interface HedgeResult {
  currency:      string;    // the currency that had a shortfall
  shortfall:     number;    // how much we were short
  from_currency: string;    // source currency used to hedge
  from_amount:   number;    // how much source currency was spent (or would be)
  gtp_reference?: string;   // Expedier swap reference (only when status = 'executed')
  status:        'executed' | 'skipped' | 'failed';
  reason?:       string;    // why it was skipped or what error occurred
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
  hedge_results?:      HedgeResult[];   // populated when AUTO_HEDGE_ENABLED=true
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

// ── Auto-hedge ────────────────────────────────────────────────────────────────
// Runs automatically after each reconciliation when AUTO_HEDGE_ENABLED=true.
// For every currency in 'critical' shortfall it executes a GTP swap from the
// configured source wallet to restore the Expedier balance.
//
// Safety rails:
//   AUTO_HEDGE_MIN_SHORTFALL  — skip currencies with variance below this (default 1.00)
//   AUTO_HEDGE_MAX_PER_RUN    — total source-currency spend cap per cycle (default 5000)
//   Cannot hedge the source currency against itself.
//
// The swap is fire-and-forget from the reconciliation's perspective — the GTP
// balance won't update immediately. The circuit breaker stays tripped until the
// NEXT reconciliation confirms the position has recovered.
export async function runAutoHedge(
  positions:      CurrencyPosition[],
  sourceCurrency: string,
): Promise<HedgeResult[]> {
  const minShortfall = parseFloat(process.env.AUTO_HEDGE_MIN_SHORTFALL ?? '1.00');
  const maxPerRun    = parseFloat(process.env.AUTO_HEDGE_MAX_PER_RUN   ?? '5000');
  let totalSpent = 0;
  const results: HedgeResult[] = [];

  // Only hedge currencies that are critical AND have a real Expedier position
  const candidates = positions.filter(
    p => p.status === 'critical' && p.expedier_balance !== 'N/A',
  );

  for (const pos of candidates) {
    const variance = parseFloat(pos.variance);
    const shortfall = Math.abs(variance);

    if (shortfall < minShortfall) {
      results.push({ currency: pos.currency, shortfall, from_currency: sourceCurrency, from_amount: 0, status: 'skipped', reason: `Below min threshold (${minShortfall})` });
      continue;
    }

    if (pos.currency === sourceCurrency) {
      results.push({ currency: pos.currency, shortfall, from_currency: sourceCurrency, from_amount: 0, status: 'skipped', reason: 'Source and target currency are the same' });
      continue;
    }

    // Fetch rate: shortfall is in `pos.currency`; convert to source spend amount
    // Rate query = "how much source do I get per 1 target?" → target/source rate
    let rate: number | null = null;
    try {
      const { data } = await gtp.get(`/rates/${pos.currency}/${sourceCurrency}`);
      rate = parseFloat(data.data?.buy_rate ?? '0') || null;
    } catch { /* no rate — fall back to 1:1 */ }

    const fromAmount = rate
      ? parseFloat((shortfall * rate).toFixed(2))
      : parseFloat(shortfall.toFixed(2));

    if (totalSpent + fromAmount > maxPerRun) {
      results.push({ currency: pos.currency, shortfall, from_currency: sourceCurrency, from_amount: fromAmount, status: 'skipped', reason: `Would exceed AUTO_HEDGE_MAX_PER_RUN (${maxPerRun} ${sourceCurrency})` });
      continue;
    }

    try {
      const { data: swapData } = await gtp.post('/swap', {
        from_currency: sourceCurrency,
        to_currency:   pos.currency,
        amount:        fromAmount.toFixed(2),
        reference:     `AUTHEDGE-${pos.currency}-${Date.now()}`,
        metadata:      { type: 'auto_hedge', triggered_by: 'reconciliation' },
      });
      totalSpent += fromAmount;
      const ref = String(swapData.data?.swap?.reference ?? swapData.data?.reference ?? '');
      console.log(`🏦  Auto-hedge executed: ${sourceCurrency} ${fromAmount.toFixed(2)} → ${pos.currency} ${shortfall.toFixed(2)} shortfall covered (ref=${ref || 'n/a'})`);
      results.push({ currency: pos.currency, shortfall, from_currency: sourceCurrency, from_amount: fromAmount, gtp_reference: ref || undefined, status: 'executed' });
    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'GTP error';
      console.error(`⚠️  Auto-hedge failed for ${pos.currency}:`, msg);
      results.push({ currency: pos.currency, shortfall, from_currency: sourceCurrency, from_amount: fromAmount, status: 'failed', reason: msg });
    }
  }

  return results;
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

  // ── Circuit breaker management ───────────────────────────────────────────
  // Trip breakers for currencies with a critical shortfall;
  // auto-lift breakers for currencies that are back to OK.
  const criticalCurrencies = new Set(
    fraudFlags
      .filter(f => f.type === 'TREASURY_SHORTFALL' && f.severity === 'critical' && f.currency)
      .map(f => f.currency!),
  );

  const okCurrencies = positions
    .filter(p => p.status === 'ok')
    .map(p => p.currency);

  // Trip
  await Promise.allSettled(
    [...criticalCurrencies].map(currency => {
      const flag = fraudFlags.find(f => f.currency === currency && f.type === 'TREASURY_SHORTFALL');
      return freezeCurrency(
        currency,
        `Treasury shortfall: owes ${flag?.amount ?? '?'} more than Expedier holds`,
        'treasury_auto',
        snapshotId,
        flag?.amount,
      );
    }),
  );

  // Lift — only clear auto-set breakers; leave admin-manual ones alone
  if (okCurrencies.length > 0) {
    const currentFreezes = await listFrozen().catch(() => []);
    const autoFreezes = currentFreezes.filter(f => f.frozen_by === 'treasury_auto');
    await Promise.allSettled(
      autoFreezes
        .filter(f => okCurrencies.includes(f.currency))
        .map(f => unfreezeCurrency(f.currency)),
    );
  }

  // ── Logging & alerts ─────────────────────────────────────────────────────
  if (overallStatus !== 'ok') {
    console.error(`\n${'█'.repeat(60)}`);
    console.error(`⚠️  TREASURY ALERT  [${snapshot.timestamp}]  status=${overallStatus.toUpperCase()}`);
    for (const f of fraudFlags) {
      console.error(`   [${f.severity.toUpperCase()}] ${f.type}: ${f.detail}`);
    }
    if (criticalCurrencies.size > 0) {
      console.error(`🔴 CIRCUIT BREAKERS TRIPPED: ${[...criticalCurrencies].join(', ')}`);
    }
    console.error(`${'█'.repeat(60)}\n`);

    // Email + Slack alert (fire-and-forget)
    sendTreasuryAlert(
      overallStatus,
      fraudFlags.map(f => ({
        type:     f.type,
        severity: f.severity,
        detail:   f.detail,
        currency: f.currency,
        amount:   f.amount,
      })),
    ).catch(() => {});
  } else {
    console.log(`✅  Treasury OK  [${snapshot.timestamp}]  accounts=${ledgerData.total}  duration=${snapshot.duration_ms}ms`);
  }

  // ── Auto-hedge shortfalls ───────────────────────────────────────────────────
  // Fires after snapshot + circuit breakers are set so the recorded state is
  // always the real observed state, not a post-hedge guess.
  // The GTP swap settles asynchronously; the next reconciliation will confirm recovery.
  if (process.env.AUTO_HEDGE_ENABLED === 'true') {
    const sourceCurrency = (process.env.AUTO_HEDGE_SOURCE_CURRENCY ?? 'CAD').toUpperCase();
    const criticalPositions = positions.filter(p => p.status === 'critical' && p.expedier_balance !== 'N/A');
    if (criticalPositions.length > 0) {
      console.log(`🏦  Auto-hedge triggered — ${criticalPositions.length} critical shortfall(s), source=${sourceCurrency}`);
      runAutoHedge(criticalPositions, sourceCurrency).then(hedgeResults => {
        const executed = hedgeResults.filter(r => r.status === 'executed').length;
        const failed   = hedgeResults.filter(r => r.status === 'failed').length;
        const skipped  = hedgeResults.filter(r => r.status === 'skipped').length;
        console.log(`🏦  Auto-hedge complete: ${executed} executed, ${skipped} skipped, ${failed} failed`);
        if (failed > 0) {
          console.error(`⚠️  ${failed} auto-hedge swap(s) failed — check logs. Shortfalls will persist until manual intervention or next cycle.`);
        }
        // Persist hedge results into the snapshot for the admin dashboard
        saveSnapshot({ ...snapshot, hedge_results: hedgeResults }).catch(() => {});
      }).catch(err => {
        console.error('⚠️  Auto-hedge run threw unexpectedly:', err);
      });
    }
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
        // Store arrays as JSON strings to avoid DynamoDB nested-type complexity
        positions:     JSON.stringify(snapshot.positions),
        fraud_flags:   JSON.stringify(snapshot.fraud_flags),
        hedge_results: snapshot.hedge_results ? JSON.stringify(snapshot.hedge_results) : undefined,
        ttl:           Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, // 90-day retention
      },
    }));
  } catch (err) {
    console.error('Failed to save treasury snapshot:', err);
  }
}

export async function getSnapshots(limit = 20): Promise<TreasurySnapshot[]> {
  try {
    // DynamoDB Scan is unordered and Limit caps items *scanned*, not returned.
    // With 100s of snapshots a small Limit misses the newest rows entirely.
    // Paginate through the full table, sort client-side, then slice.
    const all: Array<TreasurySnapshot & { positions: string; fraud_flags: string }> = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const res = await db.send(new ScanCommand({
        TableName:         SNAPSHOTS_TABLE,
        ExclusiveStartKey: lastKey as Record<string, import('@aws-sdk/lib-dynamodb').NativeAttributeValue> | undefined,
        ProjectionExpression: 'snapshot_id, #ts, overall_status, duration_ms, triggered_by, total_accounts, expedier_available, positions, fraud_flags',
        ExpressionAttributeNames: { '#ts': 'timestamp' },
      }));
      for (const item of (res.Items ?? [])) {
        all.push(item as TreasurySnapshot & { positions: string; fraud_flags: string });
      }
      lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    return all
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
      .map(item => {
        const snap = item as TreasurySnapshot & { positions: string; fraud_flags: string; hedge_results?: string };
        return {
          ...snap,
          positions:    JSON.parse(snap.positions   ?? '[]') as CurrencyPosition[],
          fraud_flags:  JSON.parse(snap.fraud_flags  ?? '[]') as FraudFlag[],
          hedge_results: snap.hedge_results ? JSON.parse(snap.hedge_results) as HedgeResult[] : undefined,
        };
      });
  } catch {
    return [];
  }
}

export async function getLatestSnapshot(): Promise<TreasurySnapshot | null> {
  const snaps = await getSnapshots(1);
  return snaps[0] ?? null;
}
