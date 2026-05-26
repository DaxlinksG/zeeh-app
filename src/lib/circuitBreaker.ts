/**
 * Treasury Circuit Breaker
 *
 * When the treasury reconciliation detects a CRITICAL shortfall for a currency,
 * it freezes OUTFLOWS for that currency to stop the bleeding:
 *   ✗ Blocked:  swap (FROM that currency), transfer, P2P send
 *   ✓ Allowed:  deposit, swap TO that currency, admin credit
 *
 * The freeze is lifted automatically the next time reconciliation passes (variance OK),
 * or an admin can manually clear it via DELETE /admin/circuit-breakers/:currency.
 *
 * Table: zeeh-circuit-breakers  (PK: currency, e.g. "USD")
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });
const db     = DynamoDBDocumentClient.from(dynamo);

const TABLE = process.env.CIRCUIT_BREAKER_TABLE ?? 'zeeh-circuit-breakers';

export interface CircuitBreakerRecord {
  currency:    string;
  frozen:      true;
  reason:      string;
  frozen_at:   string;
  frozen_by:   'treasury_auto' | 'admin_manual';
  snapshot_id?: string;
  // what gap triggered this
  shortfall?:  string;
}

// Cache to avoid a DB round-trip on every swap request.
// TTL: 60s — stale at worst 1 minute, fine for a circuit breaker.
const cache = new Map<string, { frozen: boolean; ts: number }>();
const CACHE_TTL_MS = 60_000;

function cacheSet(currency: string, frozen: boolean) {
  cache.set(currency, { frozen, ts: Date.now() });
}
function cacheLookup(currency: string): boolean | null {
  const entry = cache.get(currency);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(currency); return null; }
  return entry.frozen;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns true if outflows for `currency` are currently frozen */
export async function isFrozen(currency: string): Promise<boolean> {
  const cached = cacheLookup(currency);
  if (cached !== null) return cached;

  try {
    const result = await db.send(new GetCommand({
      TableName: TABLE,
      Key: { currency: currency.toUpperCase() },
    }));
    const frozen = !!result.Item?.frozen;
    cacheSet(currency, frozen);
    return frozen;
  } catch {
    // If DynamoDB is down, default to NOT frozen — availability > safety during outage
    return false;
  }
}

/** Freeze outflows for a currency */
export async function freezeCurrency(
  currency:    string,
  reason:      string,
  by:          'treasury_auto' | 'admin_manual',
  snapshotId?: string,
  shortfall?:  string,
): Promise<CircuitBreakerRecord> {
  const record: CircuitBreakerRecord = {
    currency:    currency.toUpperCase(),
    frozen:      true,
    reason,
    frozen_at:   new Date().toISOString(),
    frozen_by:   by,
    snapshot_id: snapshotId,
    shortfall,
  };
  await db.send(new PutCommand({ TableName: TABLE, Item: record }));
  cacheSet(currency, true);
  console.warn(`🔴 CIRCUIT BREAKER TRIPPED: ${currency} outflows frozen — ${reason}`);
  return record;
}

/** Lift freeze for a currency */
export async function unfreezeCurrency(currency: string): Promise<void> {
  await db.send(new DeleteCommand({
    TableName: TABLE,
    Key: { currency: currency.toUpperCase() },
  }));
  cacheSet(currency, false);
  console.log(`🟢 CIRCUIT BREAKER CLEARED: ${currency} outflows restored`);
}

/** List all active freezes */
export async function listFrozen(): Promise<CircuitBreakerRecord[]> {
  try {
    const result = await db.send(new ScanCommand({ TableName: TABLE }));
    return (result.Items ?? []) as CircuitBreakerRecord[];
  } catch {
    return [];
  }
}

/** Called from the circuit breaker check middleware — throws FrozenCurrencyError */
export class FrozenCurrencyError extends Error {
  constructor(public readonly currency: string) {
    super(`CURRENCY_FROZEN`);
  }
}

/** Convenience: assert a currency is not frozen, throw if it is */
export async function assertNotFrozen(currency: string): Promise<void> {
  if (await isFrozen(currency)) {
    throw new FrozenCurrencyError(currency);
  }
}
