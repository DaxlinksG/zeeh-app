/**
 * Deposit Instructions — admin-configurable per-currency bank details.
 *
 * Stored in `zeeh-deposit-instructions` DynamoDB table (PK: currency).
 * These take priority over / are merged with GTP wallet data on /me/deposit.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });
const db     = DynamoDBDocumentClient.from(client);

const TABLE = 'zeeh-deposit-instructions';

export interface DepositInstruction {
  currency:       string;   // PK — uppercase e.g. "CAD"
  bank_name?:     string;
  account_name?:  string;
  account_number?: string;
  iban?:          string;
  swift?:         string;
  sort_code?:     string;
  send_to_email?: string;
  wallet_id?:     string;
  enabled:        boolean;
  updated_at:     string;
}

export async function listDepositInstructions(): Promise<DepositInstruction[]> {
  try {
    const { Items } = await db.send(new ScanCommand({ TableName: TABLE }));
    return ((Items ?? []) as DepositInstruction[]).filter(i => i.enabled !== false);
  } catch (err: unknown) {
    // Table may not exist yet in a new environment — return empty gracefully
    if ((err as { name?: string }).name === 'ResourceNotFoundException') return [];
    throw err;
  }
}

export async function getDepositInstruction(currency: string): Promise<DepositInstruction | null> {
  try {
    const { Item } = await db.send(new GetCommand({
      TableName: TABLE,
      Key: { currency: currency.toUpperCase() },
    }));
    return (Item as DepositInstruction) ?? null;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

export async function putDepositInstruction(instruction: Omit<DepositInstruction, 'updated_at'>): Promise<DepositInstruction> {
  const item: DepositInstruction = {
    ...instruction,
    currency:   instruction.currency.toUpperCase(),
    enabled:    instruction.enabled !== false,
    updated_at: new Date().toISOString(),
  };
  await db.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function deleteDepositInstruction(currency: string): Promise<void> {
  await db.send(new DeleteCommand({
    TableName: TABLE,
    Key: { currency: currency.toUpperCase() },
  }));
}
