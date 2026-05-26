/**
 * Client Ledger — per-client, per-currency balance tracking
 *
 * Every client has a row in zeeh-client-ledger for each currency they hold.
 * Every debit/credit is recorded in zeeh-ledger-txns for full audit trail.
 *
 * Atomic balance check + deduct uses DynamoDB ConditionExpression so two
 * simultaneous requests can never double-spend the same balance.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  TransactWriteCommand,
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
function dec(a: string, b: string): string {
  return (parseFloat(a) - parseFloat(b)).toFixed(2);
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

// ── Credit (deposit) ───────────────────────────────────────────────────────
export async function creditBalance(
  clientId:    string,
  currency:    string,
  amount:      string,
  reference:   string,
  description: string,
  metadata?:   Record<string, unknown>,
): Promise<LedgerBalance> {
  const current = await ensureBalance(clientId, currency);
  const newBalance   = add(current.balance, amount);
  const newAvailable = add(current.available, amount);
  const now          = new Date().toISOString();

  await db.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: LEDGER_TABLE,
          Key: { client_id: clientId, currency },
          UpdateExpression: 'SET balance = :b, available = :a, updated_at = :t',
          ExpressionAttributeValues: { ':b': newBalance, ':a': newAvailable, ':t': now },
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
}

// ── Debit (transfer or swap_debit) — atomic, fails if insufficient ─────────
export async function debitBalance(
  clientId:    string,
  currency:    string,
  amount:      string,
  type:        LedgerTxn['type'],
  reference:   string,
  description: string,
  metadata?:   Record<string, unknown>,
): Promise<LedgerBalance> {
  const current = await ensureBalance(clientId, currency);

  if (parseFloat(current.available) < parseFloat(amount)) {
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
            // Atomic guard — reject if available has changed since we read it
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
  } catch (err: unknown) {
    // ConditionCheckFailure = concurrent request already moved the balance
    if ((err as { name?: string }).name === 'TransactionCanceledException') {
      throw new InsufficientBalanceError(currency, amount, current.available);
    }
    throw err;
  }

  return { ...current, balance: newBalance, available: newAvailable, updated_at: now };
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
