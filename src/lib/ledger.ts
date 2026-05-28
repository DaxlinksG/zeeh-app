/**
 * Client Ledger — per-client, per-currency balance tracking
 *
 * Every client has a row in zeeh-client-ledger for each currency they hold.
 * Every debit/credit is recorded in zeeh-ledger-txns for full audit trail.
 *
 * Atomic balance check + deduct uses DynamoDB ConditionExpression so two
 * simultaneous requests can never double-spend the same balance.
 *
 * creditBalance also uses optimistic locking (up to 3 retries) so concurrent
 * credits can never overwrite each other.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  TransactWriteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });
const db = DynamoDBDocumentClient.from(client);

const LEDGER_TABLE = process.env.LEDGER_TABLE  ?? 'zeeh-client-ledger';
const TXN_TABLE    = process.env.TXN_TABLE     ?? 'zeeh-ledger-txns';

// ── Types ──────────────────────────────────────────────────────────────────
export interface LedgerBalance {
  client_id:  string;
  currency:   string;
  balance:    string;   // total credited
  reserved:   string;   // locked in pending txns
  available:  string;   // balance - reserved  ← what we check before debiting
  updated_at: string;
}

export interface LedgerTxn {
  client_id:     string;
  txn_id:        string;   // timestamp + random — sortable
  type:          'deposit' | 'transfer' | 'swap_debit' | 'swap_credit' | 'refund' | 'fee';
  currency:      string;
  amount:        string;   // always positive
  direction:     'credit' | 'debit';
  balance_after: string;
  reference:     string;
  description:   string;
  created_at:    string;
  metadata?:     Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────────────
// dec() is defence-in-depth ONLY — debitBalance's ConditionExpression is the
// primary atomic guard. If somehow this is called with a > b it is a bug and
// must throw loudly rather than silently produce a negative balance string.
function dec(a: string, b: string): string {
  const result = parseFloat(a) - parseFloat(b);
  if (result < -0.001) {
    throw new Error(`LEDGER_ARITHMETIC_UNDERFLOW: ${a} - ${b} = ${result.toFixed(4)}. This is a critical bug — balance would go negative.`);
  }
  return Math.max(0, result).toFixed(2);
}
function add(a: string, b: string): string {
  return (parseFloat(a) + parseFloat(b)).toFixed(2);
}
function txnId(): string {
  return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// ── Ensure ledger row exists ───────────────────────────────────────────────
async function ensureBalance(clientId: string, currency: string): Promise<LedgerBalance> {
  const result = await db.send(new GetCommand({
    TableName: LEDGER_TABLE,
    Key: { client_id: clientId, currency },
  }));

  if (result.Item) return result.Item as LedgerBalance;

  // First time — create a zero balance row
  const row: LedgerBalance = {
    client_id:  clientId,
    currency,
    balance:    '0.00',
    reserved:   '0.00',
    available:  '0.00',
    updated_at: new Date().toISOString(),
  };
  await db.send(new PutCommand({ TableName: LEDGER_TABLE, Item: row, ConditionExpression: 'attribute_not_exists(client_id)' })).catch(() => {/* race — already created */});
  return row;
}

// ── Get balance ────────────────────────────────────────────────────────────
export async function getBalance(clientId: string, currency: string): Promise<LedgerBalance> {
  return ensureBalance(clientId, currency);
}

export async function getAllBalances(clientId: string): Promise<LedgerBalance[]> {
  const result = await db.send(new QueryCommand({
    TableName: LEDGER_TABLE,
    KeyConditionExpression: 'client_id = :id',
    ExpressionAttributeValues: { ':id': clientId },
  }));
  return (result.Items ?? []) as LedgerBalance[];
}

// ── Credit (deposit) — optimistic locking, up to 3 retries ───────────────
// Uses ConditionExpression to guard against concurrent writes overwriting
// each other. Retries up to 3 times on contention before throwing.
export async function creditBalance(
  clientId:    string,
  currency:    string,
  amount:      string,
  reference:   string,
  description: string,
  metadata?:   Record<string, unknown>,
): Promise<LedgerBalance> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const current      = await ensureBalance(clientId, currency);
    const newBalance   = add(current.balance, amount);
    const newAvailable = add(current.available, amount);
    const now          = new Date().toISOString();

    try {
      await db.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: LEDGER_TABLE,
              Key: { client_id: clientId, currency },
              UpdateExpression: 'SET balance = :b, available = :a, updated_at = :t',
              // Optimistic lock — reject if another writer changed balance since we read it
              ConditionExpression: 'balance = :currentBalance',
              ExpressionAttributeValues: {
                ':b':             newBalance,
                ':a':             newAvailable,
                ':t':             now,
                ':currentBalance': current.balance,
              },
            },
          },
          {
            Put: {
              TableName: TXN_TABLE,
              Item: {
                client_id: clientId,
                txn_id:    txnId(),
                type:      'deposit',
                currency,
                amount,
                direction:     'credit',
                balance_after: newBalance,
                reference,
                description,
                created_at: now,
                metadata: metadata ?? {},
              } as LedgerTxn,
            },
          },
        ],
      }));

      return { ...current, balance: newBalance, available: newAvailable, updated_at: now };
    } catch (err: unknown) {
      const isContention = (err as { name?: string }).name === 'TransactionCanceledException';
      if (isContention && attempt < MAX_RETRIES) {
        // Brief back-off before retry (10ms × attempt)
        await new Promise(r => setTimeout(r, 10 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  throw new Error(`creditBalance: failed after ${MAX_RETRIES} retries due to concurrent writes`);
}

// ── Debit (transfer or swap_debit) — atomic, fails if insufficient ─────────
// Uses DynamoDB ConditionExpression on `available` to prevent double-spend under
// concurrent requests. Retries up to MAX_RETRIES times in case the contention was
// caused by a concurrent CREDIT (deposit) rather than another debit — a credit
// increases `available` so the debit might now succeed on the next read.
export async function debitBalance(
  clientId:    string,
  currency:    string,
  amount:      string,
  type:        LedgerTxn['type'],
  reference:   string,
  description: string,
  metadata?:   Record<string, unknown>,
): Promise<LedgerBalance> {
  const MAX_RETRIES = 3;
  const amountNum = parseFloat(amount);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const current = await ensureBalance(clientId, currency);

    if (parseFloat(current.available) < amountNum) {
      throw new InsufficientBalanceError(currency, amount, current.available);
    }

    const newBalance   = dec(current.balance, amount);
    const newAvailable = dec(current.available, amount);
    const now          = new Date().toISOString();

    try {
      await db.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: LEDGER_TABLE,
              Key: { client_id: clientId, currency },
              UpdateExpression: 'SET balance = :b, available = :a, updated_at = :t',
              // Atomic guard — the write is rejected if another writer changed
              // `available` between our read and this write.
              ConditionExpression: 'available = :currentAvail',
              ExpressionAttributeValues: {
                ':b':            newBalance,
                ':a':            newAvailable,
                ':t':            now,
                ':currentAvail': current.available,
              },
            },
          },
          {
            Put: {
              TableName: TXN_TABLE,
              Item: {
                client_id: clientId,
                txn_id:    txnId(),
                type,
                currency,
                amount,
                direction:     'debit',
                balance_after: newBalance,
                reference,
                description,
                created_at: now,
                metadata: metadata ?? {},
              } as LedgerTxn,
            },
          },
        ],
      }));

      return { ...current, balance: newBalance, available: newAvailable, updated_at: now };
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'TransactionCanceledException') throw err;

      // Contention: re-read the balance to determine whether to retry or reject.
      // If a concurrent debit happened, available is now lower → reject.
      // If a concurrent credit happened, available may be higher → retry the debit.
      if (attempt < MAX_RETRIES) {
        const fresh = await ensureBalance(clientId, currency);
        if (parseFloat(fresh.available) < amountNum) {
          throw new InsufficientBalanceError(currency, amount, fresh.available);
        }
        // Balance is still sufficient — the contention was a credit, retry.
        await new Promise(r => setTimeout(r, 15 * (attempt + 1)));
        continue;
      }

      // Exhausted retries — read one final time for an accurate error message.
      const final = await ensureBalance(clientId, currency);
      throw new InsufficientBalanceError(currency, amount, final.available);
    }
  }

  // TypeScript: unreachable but satisfies return type
  throw new InsufficientBalanceError(currency, amount, '0.00');
}

// ── Refund (reverse a failed transaction) ─────────────────────────────────
export async function refundBalance(
  clientId:  string,
  currency:  string,
  amount:    string,
  reference: string,
  reason:    string,
): Promise<void> {
  await creditBalance(clientId, currency, amount, reference, `Refund: ${reason}`);
}

// ── Idempotency check — has this reference been processed already? ─────────
// Used by transfers and swaps to prevent double-debits on duplicate requests.
export async function findTransactionByReference(
  clientId:   string,
  reference:  string,
  direction:  'debit' | 'credit' = 'debit',
): Promise<LedgerTxn | null> {
  // Scan recent txns for this client filtered by reference
  // (a GSI on reference would be faster at scale — acceptable for now)
  const result = await db.send(new QueryCommand({
    TableName:                 TXN_TABLE,
    KeyConditionExpression:    'client_id = :id',
    FilterExpression:          'reference = :ref AND direction = :dir',
    ExpressionAttributeValues: { ':id': clientId, ':ref': reference, ':dir': direction },
    ScanIndexForward:          false,
    Limit:                     10,
  }));
  if (!result.Items || result.Items.length === 0) return null;
  return result.Items[0] as LedgerTxn;
}

// ── Transaction history ────────────────────────────────────────────────────
export async function getTransactions(
  clientId: string,
  limit = 50,
): Promise<LedgerTxn[]> {
  const result = await db.send(new QueryCommand({
    TableName: TXN_TABLE,
    KeyConditionExpression: 'client_id = :id',
    ExpressionAttributeValues: { ':id': clientId },
    ScanIndexForward: false, // newest first
    Limit: limit,
  }));
  return (result.Items ?? []) as LedgerTxn[];
}

// ── Admin: scan all transactions across all clients ────────────────────────
// Uses a full DynamoDB Scan — call from admin-only endpoints, not hot paths.
export async function scanAllTransactions(opts: {
  limit?:    number;
  type?:     string;
  currency?: string;
}): Promise<LedgerTxn[]> {
  const { limit = 300, type, currency } = opts;

  const filterParts: string[] = [];
  const exprValues: Record<string, unknown>  = {};
  const exprNames:  Record<string, string>   = {};

  if (type) {
    filterParts.push('#txntype = :type');
    exprValues[':type'] = type;
    exprNames['#txntype'] = 'type';
  }
  if (currency) {
    filterParts.push('currency = :cur');
    exprValues[':cur'] = currency.toUpperCase();
  }

  const all: LedgerTxn[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastKey: Record<string, any> | undefined;

  do {
    const res = await db.send(new ScanCommand({
      TableName: TXN_TABLE,
      ...(filterParts.length ? {
        FilterExpression: filterParts.join(' AND '),
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
      } : {}),
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    for (const item of res.Items ?? []) all.push(item as LedgerTxn);
    lastKey = res.LastEvaluatedKey as typeof lastKey;
    // Stop early once we have well beyond what will be returned
    if (all.length >= limit * 5) break;
  } while (lastKey);

  return all
    .sort((a, b) => b.txn_id.localeCompare(a.txn_id)) // txn_id is timestamp-prefixed
    .slice(0, limit);
}

// Admin: aggregate swap P&L from transaction metadata ──────────────────────
export interface SwapRevenueSummary {
  total_swaps:  number;
  // Revenue is captured in to_currency (the spread on the received side)
  revenue_by_currency: Record<string, { revenue: number; swap_count: number; volume_from: number }>;
  // Volume traded, by from_currency
  volume_by_currency:  Record<string, number>;
}

export async function getSwapRevenueSummary(): Promise<SwapRevenueSummary> {
  const txns = await scanAllTransactions({ type: 'swap_debit', limit: 5000 });

  const revenue_by_currency: SwapRevenueSummary['revenue_by_currency'] = {};
  const volume_by_currency:  SwapRevenueSummary['volume_by_currency']  = {};

  for (const t of txns) {
    const fromCur = t.currency;
    volume_by_currency[fromCur] = (volume_by_currency[fromCur] ?? 0) + parseFloat(t.amount);

    const meta    = t.metadata ?? {};
    const revCur  = String(meta.spread_currency ?? meta.to_currency ?? '');
    const rev     = parseFloat(String(meta.spread_revenue ?? '0'));

    if (revCur) {
      if (!revenue_by_currency[revCur]) revenue_by_currency[revCur] = { revenue: 0, swap_count: 0, volume_from: 0 };
      revenue_by_currency[revCur].swap_count++;
      revenue_by_currency[revCur].volume_from += parseFloat(t.amount);
      if (!isNaN(rev)) revenue_by_currency[revCur].revenue += rev;
    }
  }

  return { total_swaps: txns.length, revenue_by_currency, volume_by_currency };
}

// ── Custom errors ──────────────────────────────────────────────────────────
export class InsufficientBalanceError extends Error {
  public readonly currency:  string;
  public readonly required:  string;
  public readonly available: string;

  constructor(currency: string, required: string, available: string) {
    super(`Insufficient ${currency} balance. Required: ${required}, available: ${available}`);
    this.name      = 'InsufficientBalanceError';
    this.currency  = currency;
    this.required  = required;
    this.available = available;
  }
}
