/**
 * Wallet Cache — resolves Expedier wallet IDs by currency code.
 *
 * Expedier provisions one wallet per currency for the Zeeh platform account.
 * Wallet IDs rarely change, so we fetch once and cache in memory.
 * The cache refreshes automatically every 10 minutes and on any cache-miss.
 *
 * Usage:
 *   const walletId = await getWalletId('USD');
 *   // returns the Expedier wallet_id string, or the currency code as fallback
 */

import { gtp } from './gtpClient';

interface WalletEntry {
  wallet_id: string;   // Expedier's internal ID (may be same as currency in sandbox)
  currency:  string;
  status:    string;
}

let cache: Map<string, WalletEntry> = new Map();
let lastFetchedAt = 0;
const TTL_MS = 10 * 60 * 1000; // 10 minutes

async function refreshCache(): Promise<void> {
  try {
    const { data } = await gtp.get('/wallets');
    const wallets = (data.data?.wallets ?? []) as Record<string, unknown>[];

    const next = new Map<string, WalletEntry>();
    for (const w of wallets) {
      // Currency may be a nested object { code: 'USD' } or a plain string
      const code = (typeof w.currency === 'object' && w.currency !== null)
        ? String((w.currency as Record<string, unknown>).code ?? '').toUpperCase()
        : String(w.currency ?? '').toUpperCase();

      if (!code) continue;

      // wallet_id is null in sandbox — fall back to currency code so swaps still work
      const id = String(w.wallet_id ?? w.id ?? code);

      next.set(code, { wallet_id: id, currency: code, status: String(w.status ?? '') });
    }

    if (next.size > 0) {
      cache = next;
      lastFetchedAt = Date.now();
    }
  } catch (err) {
    console.warn('[walletCache] Failed to refresh wallet cache:', err);
  }
}

/**
 * Returns the Expedier wallet_id for the given currency.
 * Falls back to the currency code itself if the wallet is not found
 * (Expedier's swap API accepts currency codes in sandbox).
 */
export async function getWalletId(currency: string): Promise<string> {
  const cur = currency.toUpperCase();

  const isStale = Date.now() - lastFetchedAt > TTL_MS;
  const isMiss  = !cache.has(cur);

  if (isStale || isMiss) {
    await refreshCache();
  }

  return cache.get(cur)?.wallet_id ?? cur; // fallback: currency code
}

/**
 * Returns the full wallet map — used during startup healthcheck and admin tooling.
 */
export async function getAllWallets(): Promise<WalletEntry[]> {
  if (cache.size === 0 || Date.now() - lastFetchedAt > TTL_MS) {
    await refreshCache();
  }
  return [...cache.values()];
}

/**
 * Eagerly warm the cache — call once at server startup.
 */
export async function warmWalletCache(): Promise<void> {
  await refreshCache();
  console.log(`[walletCache] Loaded ${cache.size} wallets: ${[...cache.keys()].join(', ')}`);
}
