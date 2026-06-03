/**
 * Credit Store — Nigerian + Canadian credit report cache per user.
 *
 * Table: zeeh-credit (PK: user_id)
 *
 * BVN is stored AES-256-GCM encrypted so it can be used to refresh
 * reports on demand. The raw BVN is never logged.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' }),
);

const CREDIT_TABLE = process.env.CREDIT_TABLE ?? 'zeeh-credit';

// ── BVN encryption (AES-256-GCM) ──────────────────────────────────────────
// CREDIT_ENCRYPTION_KEY must be 32 bytes (hex = 64 chars) in env.
// Falls back to a dev-only key — NEVER use the fallback in production.
function getEncKey(): Buffer {
  const hex = process.env.CREDIT_ENCRYPTION_KEY ?? '';
  if (!hex || hex.length < 64) {
    if (process.env.NODE_ENV === 'production') throw new Error('CREDIT_ENCRYPTION_KEY not set');
    return crypto.scryptSync('dev-only-key-not-for-prod', 'zeeh-salt', 32);
  }
  return Buffer.from(hex, 'hex');
}

export function encryptBvn(bvn: string): string {
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncKey(), iv);
  const enc = Buffer.concat([cipher.update(bvn, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: iv(24) + tag(32) + ciphertext(hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptBvn(encrypted: string): string {
  const [ivHex, tagHex, ctHex] = encrypted.split(':');
  const iv  = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct  = Buffer.from(ctHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncKey(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString('utf8') + decipher.final('utf8');
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface CreditEnquiry {
  loanType:        string;
  date:            string;
  institutionType: string;
}

export interface LoanPerformance {
  loanProvider:       string;
  loanAmount:         string;
  status:             string;
  performanceStatus:  string;
  overdueAmount:      string;
  outstandingBalance: string;
  loanCount:          number;
}

export interface NigerianCreditReport {
  fico_score:              number;
  fico_rating:             string;
  fico_reasons:            string;
  total_loans:             number;
  active_loans:            number;
  closed_loans:            number;
  delinquent_facilities:   number;
  total_borrowed:          number;
  total_outstanding:       number;
  total_overdue:           number;
  max_overdue_days:        number | null;
  institutions:            number;
  credit_enquiries:        CreditEnquiry[];
  loan_performance:        LoanPerformance[];
  last_reported_date:      string;
  report_order_number:     string;
  fetched_at:              string;
}

export interface CreditRecord {
  user_id:          string;
  bvn_encrypted:    string;
  nigerian_report:  NigerianCreditReport | null;
  canadian_report:  null;           // future: Equifax / TransUnion
  created_at:       string;
  updated_at:       string;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function getCreditRecord(userId: string): Promise<CreditRecord | null> {
  const res = await client.send(new GetCommand({ TableName: CREDIT_TABLE, Key: { user_id: userId } }));
  return (res.Item as CreditRecord) ?? null;
}

export async function saveCreditRecord(record: CreditRecord): Promise<void> {
  await client.send(new PutCommand({ TableName: CREDIT_TABLE, Item: record }));
}

// ── Translation model helpers ──────────────────────────────────────────────
// Not needed since CRC already provides a FICO score (same 300-850 scale as
// Equifax/TransUnion). Both scores are directly comparable.
// Kept here for the future calibration / blended score work.

export type ScoreRating = 'Exceptional' | 'Very Good' | 'Good' | 'Fair' | 'Poor';

export function getScoreRating(score: number): ScoreRating {
  if (score >= 800) return 'Exceptional';
  if (score >= 740) return 'Very Good';
  if (score >= 670) return 'Good';
  if (score >= 580) return 'Fair';
  return 'Poor';
}

export function getScoreColour(rating: ScoreRating): string {
  const map: Record<ScoreRating, string> = {
    Exceptional: '#10d9b2',
    'Very Good':  '#22c55e',
    Good:         '#3b82f6',
    Fair:         '#f59e0b',
    Poor:         '#ef4444',
  };
  return map[rating];
}
