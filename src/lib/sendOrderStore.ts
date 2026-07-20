import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });
const db = DynamoDBDocumentClient.from(client);

const TABLE = process.env.SEND_ORDERS_TABLE ?? 'zeeh-send-orders';

export type SendOrderStatus =
  | 'awaiting_payment'  // waiting for Interac (CAD→NGN) or NGN deposit (NGN→CAD)
  | 'cad_received'      // deposit.completed matched — CAD received (CAD→NGN only)
  | 'ngn_received'      // NGN deposit matched — about to exchange (NGN→CAD only)
  | 'payout_initiated'  // payout or exchange in flight
  | 'completed'         // funds delivered
  | 'failed'
  | 'expired';

export type SendDirection = 'CAD_NGN' | 'NGN_CAD';

export interface SendOrder {
  order_id: string;
  user_id: string;
  rc_customer_id: string;
  direction: SendDirection;

  // CAD→NGN fields
  sender_email?: string;
  recipient_account?: string;
  recipient_bank_code?: string;
  recipient_bank_name?: string;
  recipient_name?: string;

  // NGN→CAD fields
  rc_virtual_account_id?: string;  // provisioned NGN virtual account
  va_account_number?: string;
  va_account_name?: string;
  va_bank_name?: string;

  cad_amount: number;
  ngn_amount: number;
  raw_rate: number;
  customer_rate: number;
  spread_pct: number;

  status: SendOrderStatus;
  rc_payout_id?: string;
  rc_deposit_id?: string;
  rc_exchange_id?: string;
  failure_reason?: string;
  created_at: string;
  expires_at: string;
  completed_at?: string;
}

export async function createSendOrder(order: Omit<SendOrder, 'order_id' | 'created_at' | 'expires_at'>): Promise<SendOrder> {
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 60 * 1000); // 30-min rate lock

  const full: SendOrder = {
    ...order,
    order_id: crypto.randomUUID(),
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
  };

  await db.send(new PutCommand({
    TableName: TABLE,
    Item: full,
    ConditionExpression: 'attribute_not_exists(order_id)',
  }));

  return full;
}

export async function getSendOrder(orderId: string): Promise<SendOrder | null> {
  const res = await db.send(new GetCommand({ TableName: TABLE, Key: { order_id: orderId } }));
  return (res.Item as SendOrder) ?? null;
}

export async function updateSendOrderStatus(
  orderId: string,
  status: SendOrderStatus,
  extra: Partial<Pick<SendOrder, 'rc_payout_id' | 'rc_deposit_id' | 'rc_exchange_id' | 'failure_reason' | 'completed_at'>> = {},
): Promise<void> {
  const updates: string[] = ['#st = :st'];
  const names: Record<string, string> = { '#st': 'status' };
  const values: Record<string, unknown> = { ':st': status };

  if (extra.rc_payout_id !== undefined)   { updates.push('rc_payout_id = :pid');   values[':pid'] = extra.rc_payout_id; }
  if (extra.rc_deposit_id !== undefined)  { updates.push('rc_deposit_id = :did');  values[':did'] = extra.rc_deposit_id; }
  if (extra.rc_exchange_id !== undefined) { updates.push('rc_exchange_id = :eid'); values[':eid'] = extra.rc_exchange_id; }
  if (extra.failure_reason !== undefined) { updates.push('failure_reason = :fr');  values[':fr']  = extra.failure_reason; }
  if (extra.completed_at !== undefined)   { updates.push('completed_at = :ca');    values[':ca']  = extra.completed_at; }

  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { order_id: orderId },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// Find orders awaiting payment for a given RemitClick customer — used in deposit webhook matching
export async function getPendingOrderForCustomer(rcCustomerId: string): Promise<SendOrder | null> {
  const res = await db.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'rc-customer-status-index',
    KeyConditionExpression: 'rc_customer_id = :cid',
    FilterExpression: '#st = :st AND expires_at > :now',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':cid': rcCustomerId,
      ':st': 'awaiting_payment',
      ':now': new Date().toISOString(),
    },
    Limit: 1,
  }));

  return (res.Items?.[0] as SendOrder) ?? null;
}

// Find pending NGN→CAD receive order for a customer (NGN deposit webhook matching)
export async function getPendingReceiveOrderForCustomer(rcCustomerId: string): Promise<SendOrder | null> {
  const res = await db.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'rc-customer-status-index',
    KeyConditionExpression: 'rc_customer_id = :cid',
    FilterExpression: '#st = :st AND #dir = :dir AND expires_at > :now',
    ExpressionAttributeNames: { '#st': 'status', '#dir': 'direction' },
    ExpressionAttributeValues: {
      ':cid': rcCustomerId,
      ':st': 'awaiting_payment',
      ':dir': 'NGN_CAD',
      ':now': new Date().toISOString(),
    },
    Limit: 1,
  }));

  return (res.Items?.[0] as SendOrder) ?? null;
}

// Fetch all orders for a user (for history)
export async function getUserSendOrders(userId: string, limit = 20): Promise<SendOrder[]> {
  const res = await db.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'user-id-index',
    KeyConditionExpression: 'user_id = :uid',
    ExpressionAttributeValues: { ':uid': userId },
    ScanIndexForward: false,
    Limit: limit,
  }));

  return (res.Items ?? []) as SendOrder[];
}
