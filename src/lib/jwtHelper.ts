/**
 * JWT helpers — access tokens (15 min) + refresh tokens (30 days)
 *
 * Refresh tokens are stored in zeeh-refresh-tokens DynamoDB table
 * with a TTL so they auto-expire. On logout the jti is revoked.
 */

import jwt from 'jsonwebtoken';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });
const db     = DynamoDBDocumentClient.from(client);

const TOKENS_TABLE = process.env.TOKENS_TABLE ?? 'zeeh-refresh-tokens';

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  ?? 'zeeh-access-secret-change-in-prod';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'zeeh-refresh-secret-change-in-prod';

export interface AccessPayload {
  sub:        string;   // user_id
  email:      string;
  kyc_status: string;
}

export interface RefreshPayload {
  sub: string;   // user_id
  jti: string;   // unique token id — stored in DB for revocation
}

// ── Issue access token (15 minutes) ───────────────────────────────────────
export function signAccessToken(payload: AccessPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '15m' });
}

// ── Issue refresh token (30 days) + persist to DynamoDB ───────────────────
export async function signRefreshToken(userId: string): Promise<string> {
  const jti = crypto.randomUUID();
  const expiresInSeconds = 30 * 24 * 60 * 60; // 30 days
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

  await db.send(new PutCommand({
    TableName: TOKENS_TABLE,
    Item: {
      jti,
      user_id:    userId,
      expires_at: expiresAt,   // DynamoDB TTL — auto-deleted after expiry
      revoked:    false,
      created_at: new Date().toISOString(),
    },
  }));

  return jwt.sign({ sub: userId, jti }, REFRESH_SECRET, { expiresIn: '30d' });
}

// ── Verify access token ────────────────────────────────────────────────────
export function verifyAccessToken(token: string): AccessPayload & { exp: number } {
  return jwt.verify(token, ACCESS_SECRET) as AccessPayload & { exp: number };
}

// ── Verify refresh token + check DB ───────────────────────────────────────
export async function verifyRefreshToken(token: string): Promise<RefreshPayload> {
  const payload = jwt.verify(token, REFRESH_SECRET) as RefreshPayload;

  const result = await db.send(new GetCommand({
    TableName: TOKENS_TABLE,
    Key: { jti: payload.jti },
  }));

  if (!result.Item || result.Item.revoked) {
    throw new Error('TOKEN_REVOKED');
  }

  return payload;
}

// ── Revoke refresh token (logout) ─────────────────────────────────────────
export async function revokeRefreshToken(jti: string): Promise<void> {
  await db.send(new UpdateCommand({
    TableName: TOKENS_TABLE,
    Key: { jti },
    UpdateExpression: 'SET revoked = :t',
    ExpressionAttributeValues: { ':t': true },
  })).catch(() => {/* ignore if not found */});
}

// ── Extract JTI from token without verifying (for logout) ─────────────────
export function decodeRefreshJti(token: string): string | null {
  try {
    const decoded = jwt.decode(token) as { jti?: string } | null;
    return decoded?.jti ?? null;
  } catch {
    return null;
  }
}
