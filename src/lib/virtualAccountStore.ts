/**
 * Virtual Account Store
 *
 * A virtual account gives a B2B client's end-customer a unique reference code
 * they attach to a bank transfer destined for Zeeh's pooled receiving account.
 * When the deposit arrives, Zeeh matches the reference to the virtual account,
 * credits the B2B client's ledger, and fires a webhook.
 *
 * Table: zeeh-virtual-accounts
 *   PK  : account_id          (e.g. "VA-4X8B2C")
 *   GSI : client_id + created_at  → list by client
 *   GSI : reference_code          → match inbound deposits
 */

import { randomBytes } from 'crypto';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const db    = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });
const TABLE = process.env.VIRTUAL_ACCOUNTS_TABLE ?? 'zeeh-virtual-accounts';

// ── Types ──────────────────────────────────────────────────────────────────

export interface VirtualAccount {
  account_id:    string;
  client_id:     string;   // B2B API key_id
  client_name:   string;
  customer_id:   string;   // B2B client's own customer reference
  customer_name: string;
  currency:      string;   // CAD | USD | GBP | EUR | NGN
  reference_code: string;  // unique code the customer puts in the payment reference
  status:        'active' | 'inactive';
  description?:  string;
  metadata?:     Record<string, unknown>;
  total_credited: string;  // running total of deposits matched (string decimal)
  created_at:    string;
  updated_at:    string;
}

export interface CreateVirtualAccountInput {
  customer_id:   string;
  customer_name: string;
  currency:      string;
  description?:  string;
  metadata?:     Record<string, unknown>;
}

// ── Reference code generation ──────────────────────────────────────────────
// Format: ZVA-XXXXXX (6 uppercase hex chars) — short enough to fit in a
// bank transfer reference field, unique enough for practical volumes.

function generateReferenceCode(): string {
  return 'ZVA-' + randomBytes(3).toString('hex').toUpperCase();
}

function generateAccountId(): string {
  return 'VA-' + randomBytes(4).toString('hex').toUpperCase();
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function createVirtualAccount(
  clientId:   string,
  clientName: string,
  input:      CreateVirtualAccountInput,
): Promise<VirtualAccount> {
  const now = new Date().toISOString();

  const account: VirtualAccount = {
    account_id:     generateAccountId(),
    client_id:      clientId,
    client_name:    clientName,
    customer_id:    input.customer_id,
    customer_name:  input.customer_name,
    currency:       input.currency.toUpperCase(),
    reference_code: generateReferenceCode(),
    status:         'active',
    description:    input.description,
    metadata:       input.metadata,
    total_credited: '0.00',
    created_at:     now,
    updated_at:     now,
  };

  await db.send(new PutItemCommand({
    TableName:           TABLE,
    Item:                marshall(account, { removeUndefinedValues: true }),
    ConditionExpression: 'attribute_not_exists(account_id)',
  }));

  return account;
}

export async function getVirtualAccount(accountId: string): Promise<VirtualAccount | null> {
  const result = await db.send(new GetItemCommand({ TableName: TABLE, Key: marshall({ account_id: accountId }) }));
  if (!result.Item) return null;
  return unmarshall(result.Item) as VirtualAccount;
}

export async function getVirtualAccountByReference(referenceCode: string): Promise<VirtualAccount | null> {
  const result = await db.send(new QueryCommand({
    TableName:                TABLE,
    IndexName:                'reference_code-index',
    KeyConditionExpression:   'reference_code = :rc',
    ExpressionAttributeValues: marshall({ ':rc': referenceCode }),
    Limit:                    1,
  }));
  if (!result.Items || result.Items.length === 0) return null;
  return unmarshall(result.Items[0]) as VirtualAccount;
}

export async function listVirtualAccounts(
  clientId: string,
  opts: { currency?: string; status?: string; limit?: number } = {},
): Promise<VirtualAccount[]> {
  const { currency, status, limit = 50 } = opts;

  const filterParts: string[] = [];
  const exprValues: Record<string, unknown> = { ':cid': clientId };

  if (currency) {
    filterParts.push('currency = :cur');
    exprValues[':cur'] = currency.toUpperCase();
  }
  if (status) {
    filterParts.push('#st = :status');
    exprValues[':status'] = status;
  }

  const result = await db.send(new QueryCommand({
    TableName:                 TABLE,
    IndexName:                 'client_id-created_at-index',
    KeyConditionExpression:    'client_id = :cid',
    FilterExpression:          filterParts.length ? filterParts.join(' AND ') : undefined,
    ExpressionAttributeValues: marshall(exprValues),
    ExpressionAttributeNames:  status ? { '#st': 'status' } : undefined,
    ScanIndexForward:          false, // newest first
    Limit:                     Math.min(limit, 200),
  }));

  return (result.Items ?? []).map(i => unmarshall(i) as VirtualAccount);
}

export async function deactivateVirtualAccount(accountId: string, clientId: string): Promise<void> {
  await db.send(new UpdateItemCommand({
    TableName:                 TABLE,
    Key:                       marshall({ account_id: accountId }),
    UpdateExpression:          'SET #st = :inactive, updated_at = :now',
    ConditionExpression:       'client_id = :cid', // only owner can deactivate
    ExpressionAttributeNames:  { '#st': 'status' },
    ExpressionAttributeValues: marshall({
      ':inactive': 'inactive',
      ':now':      new Date().toISOString(),
      ':cid':      clientId,
    }),
  }));
}

/** Called by the webhook handler when a deposit matches a virtual account */
export async function recordVirtualAccountCredit(
  accountId: string,
  amount:    string,
): Promise<void> {
  const existing = await getVirtualAccount(accountId);
  if (!existing) return;

  const newTotal = (parseFloat(existing.total_credited) + parseFloat(amount)).toFixed(2);

  await db.send(new UpdateItemCommand({
    TableName:                 TABLE,
    Key:                       marshall({ account_id: accountId }),
    UpdateExpression:          'SET total_credited = :total, updated_at = :now',
    ExpressionAttributeValues: marshall({
      ':total': newTotal,
      ':now':   new Date().toISOString(),
    }),
  }));
}
