/**
 * User Store — end-consumer accounts for the B2C app
 *
 * Tables:
 *   zeeh-users  (PK: user_id, GSI: email-index)
 *   zeeh-kyc    (PK: user_id)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });
const db     = DynamoDBDocumentClient.from(client);

const USERS_TABLE = process.env.USERS_TABLE ?? 'zeeh-users';
const KYC_TABLE   = process.env.KYC_TABLE   ?? 'zeeh-kyc';

export type KycStatus = 'none' | 'pending' | 'approved' | 'rejected';

export interface User {
  user_id:        string;
  email:          string;
  password_hash:  string;
  first_name:     string;
  last_name:      string;
  phone:          string;
  country:        string;
  kyc_status:     KycStatus;
  is_active:      boolean;
  created_at:     string;
  last_login_at?: string;
  email_verified: boolean;
  // OTP (stored hashed, expires via otp_expires Unix timestamp with DynamoDB TTL)
  otp_hash?:      string;
  otp_expires?:   number;
  otp_attempts?:  number;
  // Password reset token (stored hashed, 30-min expiry)
  reset_token_hash?:    string;
  reset_token_expires?: number;
  // Transaction PIN (bcrypt hash). Required before any send/swap/transfer.
  transaction_pin_hash?:  string;
  pin_failed_attempts?:   number;
  pin_locked_until?:      number; // Unix timestamp
}

export interface KycRecord {
  user_id:        string;
  date_of_birth:  string;   // YYYY-MM-DD
  nationality:    string;
  address: {
    street:      string;
    city:        string;
    state:       string;
    country:     string;
    postal_code: string;
  };
  id_type:        'passport' | 'drivers_license' | 'national_id';
  id_number:      string;
  submitted_at:   string;
  reviewed_at?:   string;
  reviewer_notes?: string;
}

// ── Create user ────────────────────────────────────────────────────────────
export async function createUser(
  email:      string,
  password:   string,
  firstName:  string,
  lastName:   string,
  phone:      string,
  country:    string,
): Promise<User> {
  // Check if email already exists
  const existing = await getUserByEmail(email);
  if (existing) throw new Error('EMAIL_EXISTS');

  const user: User = {
    user_id:        `usr_${crypto.randomBytes(12).toString('hex')}`,
    email:          email.toLowerCase().trim(),
    password_hash:  await bcrypt.hash(password, 12),
    first_name:     firstName.trim(),
    last_name:      lastName.trim(),
    phone:          phone.trim(),
    country:        country.trim(),
    kyc_status:     'none',
    is_active:      true,
    email_verified: false,
    created_at:     new Date().toISOString(),
  };

  await db.send(new PutCommand({ TableName: USERS_TABLE, Item: user }));
  return user;
}

// ── Get user by ID ─────────────────────────────────────────────────────────
export async function getUserById(userId: string): Promise<User | null> {
  const result = await db.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
  }));
  return result.Item ? (result.Item as User) : null;
}

// ── Get user by email (GSI lookup) ─────────────────────────────────────────
export async function getUserByEmail(email: string): Promise<User | null> {
  const result = await db.send(new QueryCommand({
    TableName: USERS_TABLE,
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': email.toLowerCase().trim() },
    Limit: 1,
  }));
  return result.Items?.[0] ? (result.Items[0] as User) : null;
}

// ── Verify password ────────────────────────────────────────────────────────
export async function verifyPassword(user: User, password: string): Promise<boolean> {
  return bcrypt.compare(password, user.password_hash);
}

// ── Update profile ─────────────────────────────────────────────────────────
export async function updateUserProfile(
  userId: string,
  fields: Partial<Pick<User, 'first_name' | 'last_name' | 'phone' | 'country'>>,
): Promise<void> {
  const updates: string[] = [];
  const values: Record<string, unknown> = {};

  if (fields.first_name) { updates.push('first_name = :fn'); values[':fn'] = fields.first_name; }
  if (fields.last_name)  { updates.push('last_name = :ln');  values[':ln'] = fields.last_name; }
  if (fields.phone)      { updates.push('phone = :ph');      values[':ph'] = fields.phone; }
  if (fields.country)    { updates.push('country = :co');    values[':co'] = fields.country; }
  if (updates.length === 0) return;

  await db.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeValues: values,
  }));
}

// ── Update last login ──────────────────────────────────────────────────────
export async function touchLastLogin(userId: string): Promise<void> {
  await db.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET last_login_at = :t',
    ExpressionAttributeValues: { ':t': new Date().toISOString() },
  })).catch(() => {/* non-fatal */});
}

// ── Update KYC status ──────────────────────────────────────────────────────
export async function updateKycStatus(
  userId: string,
  status: KycStatus,
  notes?: string,
): Promise<void> {
  await db.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET kyc_status = :s',
    ExpressionAttributeValues: { ':s': status },
  }));

  if (status === 'approved' || status === 'rejected') {
    await db.send(new UpdateCommand({
      TableName: KYC_TABLE,
      Key: { user_id: userId },
      UpdateExpression: 'SET reviewed_at = :t, reviewer_notes = :n',
      ExpressionAttributeValues: { ':t': new Date().toISOString(), ':n': notes ?? '' },
    })).catch(() => {});
  }
}

// ── Submit KYC ─────────────────────────────────────────────────────────────
export async function submitKyc(
  userId: string,
  data: Omit<KycRecord, 'user_id' | 'submitted_at'>,
): Promise<KycRecord> {
  const record: KycRecord = {
    user_id:       userId,
    submitted_at:  new Date().toISOString(),
    ...data,
  };
  await db.send(new PutCommand({ TableName: KYC_TABLE, Item: record }));

  // Update user's kyc_status to pending
  await db.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET kyc_status = :s',
    ExpressionAttributeValues: { ':s': 'pending' as KycStatus },
  }));

  return record;
}

// ── Get KYC record ─────────────────────────────────────────────────────────
export async function getKyc(userId: string): Promise<KycRecord | null> {
  const result = await db.send(new GetCommand({
    TableName: KYC_TABLE,
    Key: { user_id: userId },
  }));
  return result.Item ? (result.Item as KycRecord) : null;
}

// ── List all users (admin) ─────────────────────────────────────────────────
export async function listUsers(limit = 100): Promise<Omit<User, 'password_hash'>[]> {
  const result = await db.send(new ScanCommand({
    TableName: USERS_TABLE,
    Limit: limit,
    ProjectionExpression: 'user_id, email, first_name, last_name, phone, country, kyc_status, is_active, created_at, last_login_at',
  }));
  const items = (result.Items ?? []) as Omit<User, 'password_hash'>[];
  return items.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ── OTP: generate, store (hashed), verify ─────────────────────────────────
const OTP_TTL_SECONDS = 10 * 60; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;

export function generateOtp(): string {
  return String(crypto.randomInt(100000, 999999));
}

function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

export async function storeOtp(userId: string, otp: string): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + OTP_TTL_SECONDS;
  await db.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET otp_hash = :h, otp_expires = :e, otp_attempts = :a',
    ExpressionAttributeValues: {
      ':h': hashOtp(otp),
      ':e': expiresAt,
      ':a': 0,
    },
  }));
}

export async function verifyOtp(userId: string, otp: string): Promise<'ok' | 'expired' | 'invalid' | 'locked'> {
  const user = await getUserById(userId);
  if (!user?.otp_hash) return 'expired';

  if ((user.otp_attempts ?? 0) >= OTP_MAX_ATTEMPTS) return 'locked';
  if (!user.otp_expires || Math.floor(Date.now() / 1000) > user.otp_expires) return 'expired';

  const match = crypto.timingSafeEqual(
    Buffer.from(user.otp_hash, 'hex'),
    Buffer.from(hashOtp(otp), 'hex'),
  );

  if (!match) {
    // Increment attempt counter
    await db.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
      UpdateExpression: 'SET otp_attempts = otp_attempts + :one',
      ExpressionAttributeValues: { ':one': 1 },
    })).catch(() => {});
    return 'invalid';
  }

  // Valid — mark email verified, clear OTP fields
  await db.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET email_verified = :t REMOVE otp_hash, otp_expires, otp_attempts',
    ExpressionAttributeValues: { ':t': true },
  }));

  return 'ok';
}

// ── Password reset ─────────────────────────────────────────────────────────
// Uses a 32-byte random hex token, SHA-256 hashed before storage.
// Valid for 30 minutes. One active token per user at a time.

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function storePasswordResetToken(userId: string, token: string): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60; // 30 min
  await db.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET reset_token_hash = :h, reset_token_expires = :e',
    ExpressionAttributeValues: { ':h': hashToken(token), ':e': expiresAt },
  }));
}

export async function verifyPasswordResetToken(
  userId: string,
  token: string,
): Promise<'ok' | 'expired' | 'invalid'> {
  const user = await getUserById(userId);
  if (!user?.reset_token_hash) return 'expired';
  if (!user.reset_token_expires || Math.floor(Date.now() / 1000) > user.reset_token_expires) return 'expired';

  const match = crypto.timingSafeEqual(
    Buffer.from(user.reset_token_hash, 'hex'),
    Buffer.from(hashToken(token), 'hex'),
  );
  return match ? 'ok' : 'invalid';
}

export async function resetPassword(userId: string, newPassword: string): Promise<void> {
  const hash = await bcrypt.hash(newPassword, 12);
  await db.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET password_hash = :h REMOVE reset_token_hash, reset_token_expires',
    ExpressionAttributeValues: { ':h': hash },
  }));
}

// ── Transaction PIN ────────────────────────────────────────────────────────
// 4-digit numeric PIN, bcrypt-hashed, cost 10.
// Failed attempts are tracked; 5 consecutive failures trigger a 15-min lockout.

export async function setTransactionPin(userId: string, pin: string): Promise<void> {
  const hash = await bcrypt.hash(pin, 10);
  await db.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET transaction_pin_hash = :h REMOVE pin_failed_attempts, pin_locked_until',
    ExpressionAttributeValues: { ':h': hash },
  }));
}

export async function hasPinSet(userId: string): Promise<boolean> {
  const result = await db.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
  }));
  return !!(result.Item as User | undefined)?.transaction_pin_hash;
}

export type PinVerifyResult = 'ok' | 'no_pin' | 'locked' | 'invalid';

export async function verifyTransactionPin(userId: string, pin: string): Promise<PinVerifyResult> {
  const result = await db.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
  }));
  const user = result.Item as User | undefined;
  if (!user?.transaction_pin_hash) return 'no_pin';

  // Lockout check
  if (user.pin_locked_until && Math.floor(Date.now() / 1000) < user.pin_locked_until) return 'locked';

  const match = await bcrypt.compare(pin, user.transaction_pin_hash);

  if (!match) {
    const attempts = (user.pin_failed_attempts ?? 0) + 1;
    const lock     = attempts >= 5;
    await db.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
      UpdateExpression: lock
        ? 'SET pin_failed_attempts = :a, pin_locked_until = :l'
        : 'SET pin_failed_attempts = :a',
      ExpressionAttributeValues: {
        ':a': attempts,
        ...(lock ? { ':l': Math.floor(Date.now() / 1000) + 15 * 60 } : {}),
      },
    })).catch(() => {});
    return 'invalid';
  }

  // Success — clear failure counter
  if (user.pin_failed_attempts) {
    await db.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
      UpdateExpression: 'REMOVE pin_failed_attempts, pin_locked_until',
    })).catch(() => {});
  }
  return 'ok';
}

// ── Admin: suspend / unsuspend user ────────────────────────────────────────
export async function setUserActive(userId: string, active: boolean): Promise<void> {
  await db.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET is_active = :a',
    ExpressionAttributeValues: { ':a': active },
  }));
}

// ── List pending KYC submissions (admin) ───────────────────────────────────
export async function listPendingKyc(): Promise<(KycRecord & { user?: Omit<User, 'password_hash'> })[]> {
  // Get all users with kyc_status = pending
  const result = await db.send(new ScanCommand({
    TableName: USERS_TABLE,
    FilterExpression: 'kyc_status = :s',
    ExpressionAttributeValues: { ':s': 'pending' },
    ProjectionExpression: 'user_id, email, first_name, last_name, kyc_status',
  }));
  const users = (result.Items ?? []) as Omit<User, 'password_hash'>[];

  // Fetch KYC records for each
  const records = await Promise.all(
    users.map(async u => {
      const kyc = await getKyc(u.user_id);
      return kyc ? { ...kyc, user: u } : null;
    }),
  );
  return records.filter((r): r is KycRecord & { user: Omit<User, 'password_hash'> } => r !== null);
}
