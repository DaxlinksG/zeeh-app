/**
 * Pending Deposits — tracks inbound `wallet.funded` webhook events
 * that haven't yet been assigned to a client.
 *
 * Flow:
 *  1. GTP fires `wallet.funded` → webhook handler calls createPendingDeposit()
 *  2. Admin views pending deposits → calls listPendingDeposits()
 *  3. Admin assigns to client   → assignDeposit() credits the client's ledger
 *     and marks the deposit as assigned.
 *
 * Table: zeeh-pending-deposits
 *   PK: deposit_id (UUID)
 *   GSI: status-created_at-index  (for efficient "pending only" queries)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';
import { creditBalance } from './ledger';

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });
const db     = DynamoDBDocumentClient.from(client);

const DEPOSITS_TABLE = process.env.DEPOSITS_TABLE ?? 'zeeh-pending-deposits';

export type DepositStatus = 'unassigned' | 'assigned' | 'ignored';

export interface PendingDeposit {
  deposit_id:    string;
  status:        DepositStatus;
  currency:      string;
  amount:        string;
  gtp_reference: string;          // GTP's internal reference / wallet ID
  event_type:    string;          // e.g. "wallet.funded"
  raw_event:     Record<string, unknown>;
  created_at:    string;
  // populated after assignment
  assigned_to?:  string;          // key_id
  assigned_at?:  string;
  assigned_by?:  string;
  credit_ref?:   string;          // ledger reference used for the credit
}

// ── Create a new pending deposit from a webhook event ─────────────────────
export async function createPendingDeposit(
  eventType:    string,
  currency:     string,
  amount:       string,
  gtpReference: string,
  rawEvent:     Record<string, unknown>,
): Promise<PendingDeposit> {
  const deposit: PendingDeposit = {
    deposit_id:    crypto.randomUUID(),
    status:        'unassigned',
    currency:      currency.toUpperCase(),
    amount,
    gtp_reference: gtpReference,
    event_type:    eventType,
    raw_event:     rawEvent,
    created_at:    new Date().toISOString(),
  };

  await db.send(new PutCommand({
    TableName: DEPOSITS_TABLE,
    Item: deposit,
  }));

  return deposit;
}

// ── List deposits by status (default: unassigned) ─────────────────────────
export async function listPendingDeposits(
  status: DepositStatus = 'unassigned',
  limit = 100,
): Promise<PendingDeposit[]> {
  // Simple scan filtered by status — fine for low-volume admin UI
  const result = await db.send(new ScanCommand({
    TableName: DEPOSITS_TABLE,
    FilterExpression: '#s = :s',
    ExpressionAttributeNames:  { '#s': 'status' },
    ExpressionAttributeValues: { ':s': status },
    Limit: limit,
  }));

  const items = (result.Items ?? []) as PendingDeposit[];
  // Sort newest first
  return items.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ── Get a single deposit ───────────────────────────────────────────────────
export async function getDeposit(depositId: string): Promise<PendingDeposit | null> {
  const result = await db.send(new GetCommand({
    TableName: DEPOSITS_TABLE,
    Key: { deposit_id: depositId },
  }));
  return result.Item ? (result.Item as PendingDeposit) : null;
}

// ── Assign a deposit to a client — credits their ledger atomically ─────────
export async function assignDeposit(
  depositId:   string,
  keyId:       string,
  assignedBy:  string,
): Promise<PendingDeposit> {
  const deposit = await getDeposit(depositId);
  if (!deposit) throw new Error(`Deposit ${depositId} not found`);
  if (deposit.status !== 'unassigned') throw new Error(`Deposit ${depositId} is already ${deposit.status}`);

  const creditRef = `DEP-${depositId.slice(0, 8).toUpperCase()}`;

  // Credit the client's ledger
  await creditBalance(
    keyId,
    deposit.currency,
    deposit.amount,
    creditRef,
    `Deposit ${deposit.amount} ${deposit.currency} (ref: ${deposit.gtp_reference})`,
    { deposit_id: depositId, gtp_reference: deposit.gtp_reference },
  );

  // Mark the deposit as assigned — ConditionExpression prevents race condition
  // if two admins click assign simultaneously
  const now = new Date().toISOString();
  try {
    await db.send(new UpdateCommand({
      TableName: DEPOSITS_TABLE,
      Key: { deposit_id: depositId },
      UpdateExpression: 'SET #s = :s, assigned_to = :at, assigned_at = :aa, assigned_by = :ab, credit_ref = :cr',
      ConditionExpression: '#s = :unassigned',
      ExpressionAttributeNames:  { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s':           'assigned',
        ':at':          keyId,
        ':aa':          now,
        ':ab':          assignedBy,
        ':cr':          creditRef,
        ':unassigned':  'unassigned',
      },
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new Error(`Deposit ${depositId} was already assigned by another admin`);
    }
    throw err;
  }

  return { ...deposit, status: 'assigned', assigned_to: keyId, assigned_at: now, assigned_by: assignedBy, credit_ref: creditRef };
}

// ── Mark a deposit as ignored (e.g. test / internal transfer) ─────────────
export async function ignoreDeposit(depositId: string): Promise<void> {
  const deposit = await getDeposit(depositId);
  if (!deposit) throw new Error(`Deposit ${depositId} not found`);
  if (deposit.status !== 'unassigned') throw new Error(`Deposit ${depositId} is already ${deposit.status}`);

  await db.send(new UpdateCommand({
    TableName: DEPOSITS_TABLE,
    Key: { deposit_id: depositId },
    UpdateExpression: 'SET #s = :s',
    ExpressionAttributeNames:  { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'ignored' },
  }));
}
