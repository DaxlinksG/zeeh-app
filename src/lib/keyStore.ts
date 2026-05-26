import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });
const db = DynamoDBDocumentClient.from(client);

const TABLE = process.env.API_KEYS_TABLE ?? 'zeeh-api-keys';

export interface ApiKeyRecord {
  key_hash:     string;
  key_id:       string;
  client_name:  string;
  client_email: string;
  created_at:   string;
  last_used_at: string | null;
  is_active:    boolean;
}

// ── Hashing ───────────────────────────────────────────────────────────────────
export function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// ── Generate a new key ────────────────────────────────────────────────────────
export function generateKey(): string {
  return 'zk_live_' + crypto.randomBytes(24).toString('hex');
}

// ── Create a new API key ──────────────────────────────────────────────────────
export async function createApiKey(clientName: string, clientEmail: string): Promise<{ record: ApiKeyRecord; rawKey: string }> {
  const rawKey  = generateKey();
  const keyHash = hashKey(rawKey);
  const keyId   = 'key_' + crypto.randomBytes(6).toString('hex');

  const record: ApiKeyRecord = {
    key_hash:     keyHash,
    key_id:       keyId,
    client_name:  clientName,
    client_email: clientEmail,
    created_at:   new Date().toISOString(),
    last_used_at: null,
    is_active:    true,
  };

  await db.send(new PutCommand({ TableName: TABLE, Item: record }));
  return { record, rawKey };
}

// ── Look up a key (called on every request) ───────────────────────────────────
export async function lookupKey(rawKey: string): Promise<ApiKeyRecord | null> {
  const result = await db.send(new GetCommand({
    TableName: TABLE,
    Key: { key_hash: hashKey(rawKey) },
  }));

  if (!result.Item) return null;
  const record = result.Item as ApiKeyRecord;
  if (!record.is_active) return null;

  // Fire-and-forget: update last_used_at
  db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { key_hash: record.key_hash },
    UpdateExpression: 'SET last_used_at = :t',
    ExpressionAttributeValues: { ':t': new Date().toISOString() },
  })).catch(() => {/* non-critical */});

  return record;
}

// ── List all keys (admin) ─────────────────────────────────────────────────────
export async function listApiKeys(): Promise<Omit<ApiKeyRecord, 'key_hash'>[]> {
  const result = await db.send(new ScanCommand({ TableName: TABLE }));
  return (result.Items ?? []).map(({ key_hash: _omit, ...rest }) => rest) as Omit<ApiKeyRecord, 'key_hash'>[];
}

// ── Get a key by key_id (admin) ───────────────────────────────────────────────
export async function getApiKeyById(keyId: string): Promise<Omit<ApiKeyRecord, 'key_hash'> | null> {
  const result = await db.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: 'key_id = :id',
    ExpressionAttributeValues: { ':id': keyId },
    Limit: 1,
  }));
  if (!result.Items || result.Items.length === 0) return null;
  const { key_hash: _omit, ...rest } = result.Items[0] as ApiKeyRecord;
  return rest;
}

// ── Revoke a key (admin) ──────────────────────────────────────────────────────
export async function revokeApiKey(keyId: string): Promise<boolean> {
  // Scan to find the key by key_id (not key_hash — admin doesn't know the hash)
  const result = await db.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: 'key_id = :id',
    ExpressionAttributeValues: { ':id': keyId },
  }));

  if (!result.Items || result.Items.length === 0) return false;
  const item = result.Items[0] as ApiKeyRecord;

  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { key_hash: item.key_hash },
    UpdateExpression: 'SET is_active = :f',
    ExpressionAttributeValues: { ':f': false },
  }));
  return true;
}
