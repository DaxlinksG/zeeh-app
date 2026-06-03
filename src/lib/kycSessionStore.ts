/**
 * KYC Session Store — maps KYC provider session_id → our user_id.
 *
 * Table: zeeh-kyc-sessions  (PK: session_id, TTL: 90 days)
 *
 * Why this exists:
 *   The KYC provider's webhook payload includes a session_id but we cannot
 *   rely on their external_id field (stored as null in their DB for older
 *   sessions). By storing the mapping ourselves at session-creation time we
 *   can always resolve the correct user_id from any webhook, regardless of
 *   whether external_id is populated.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' }),
);

const TABLE = process.env.KYC_SESSIONS_TABLE ?? 'zeeh-kyc-sessions';
const TTL_DAYS = 90;

export async function storeKycSession(sessionId: string, userId: string): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 86_400;
  await client.send(new PutCommand({
    TableName: TABLE,
    Item: {
      session_id:  sessionId,
      user_id:     userId,
      created_at:  new Date().toISOString(),
      ttl,
    },
  }));
}

export async function getUserIdByKycSession(sessionId: string): Promise<string | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE,
    Key: { session_id: sessionId },
  }));
  return (result.Item?.user_id as string | undefined) ?? null;
}
