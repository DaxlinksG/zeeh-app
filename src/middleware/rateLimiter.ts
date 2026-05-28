import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

// Key function: rate-limit by API key when present, fall back to IP.
// This prevents:
//   - A client with rotating IPs bypassing per-client limits
//   - Multiple clients sharing a NAT being pooled into one IP bucket
function keyByApiKeyOrIp(req: Request): string {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  return apiKey ? `key:${apiKey}` : `ip:${req.ip}`;
}

// General API rate limit — all /api/* routes
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 120,                   // 120 requests per minute per key/IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  message: { success: false, message: 'Too many requests — please slow down.' },
  skip: (req) => req.path === '/health',
});

// Strict limiter for money-moving endpoints (transfers + swaps)
export const transferLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 20,                    // 20 transfer/swap attempts per minute per key/IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  message: { success: false, message: 'Transfer rate limit exceeded. Max 20 per minute.' },
});

// Looser limiter for rate/quote lookups (customers poll frequently)
export const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,                   // 300 quote requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  message: { success: false, message: 'Rate lookup limit exceeded.' },
});
