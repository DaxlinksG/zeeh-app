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
  | 'awaiting_payment'  // user has been shown Interac instructions, waiting for CAD
  | 'cad_received'      // deposit.completed webhook matched this order
  | 'payout_initiated'  // POST /v1/payouts called, RemitClick payout ID stored
  | 'completed'         // payout.completed webhook received
  | 'failed'            // payout.failed or expired
  | 'expired';          // rate lock window passed, user never sent

export interface SendOrder {
  order_id: string;
  user_id: string;
  rc_customer_id: string;
  sender_email: string;       // verified Interac email for this send
  cad_amount: number;         // CAD user must send (major units, e.g. 280.50)
  ngn_amount: number;         // NGN recipient will receive (major units)
  raw_rate: number;           // RemitClick's raw CAD→NGN rate
  customer_rate: number;      // rate after Zeeh spread applied
  spread_pct: number;
  recipient_account: string;
  recipient_bank_code: string;
  recipient_bank_name: string;
  recipient_name: string;
  status: SendOrderStatus;
  rc_payout_id?: string;      // set when payout is initiated
  rc_deposit_id?: string;     // set when deposit matched
  failure_reason?: string;
  created_at: string;
  expires_at: string;         // ISO — rate lock expiry (30 min from creation)
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
  extra: Partial<Pick<SendOrder, 'rc_payout_id' | 'rc_deposit_id' | 'failure_reason' | 'completed_at'>> = {},
): Promise<void> {
  const updates: string[] = ['#st = :st'];
  const names: Record<string, string> = { '#st': 'status' };
  const values: Record<string, unknown> = { ':st': status };

  if (extra.rc_payout_id !== undefined) { updates.push('rc_payout_id = :pid'); values[':pid'] = extra.rc_payout_id; }
  if (extra.rc_deposit_id !== undefined) { updates.push('rc_deposit_id = :did'); values[':did'] = extra.rc_deposit_id; }
  if (extra.failure_reason !== undefined) { updates.push('failure_reason = :fr'); values[':fr'] = extra.failure_reason; }
  if (extra.completed_at !== undefined) { updates.push('completed_at = :ca'); values[':ca'] = extra.completed_at; }

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
