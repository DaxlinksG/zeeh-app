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

// Auth routes — strict IP-based limit to prevent brute-force and credential stuffing.
// 10 attempts per 15 minutes per IP applies to login, register, forgot-password.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minute window
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `ip:${req.ip}`,
  message: { success: false, message: 'Too many attempts. Please wait 15 minutes before trying again.', code: 'RATE_LIMITED' },
});

// B2C user routes — per user_id (from JWT sub) with IP fallback.
// Prevents a single compromised account from hammering transactions.
export const userLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 60,                    // 60 general requests per minute (profile, balance, etc.)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      try {
        // Decode without verify (verify already happened in requireUser)
        const payload = JSON.parse(Buffer.from(auth.slice(7).split('.')[1], 'base64').toString());
        if (payload?.sub) return `uid:${payload.sub}`;
      } catch { /* fall through */ }
    }
    return `ip:${req.ip}`;
  },
  message: { success: false, message: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' },
});

// Strict limiter for B2C money-moving endpoints (send, swap, transfer)
export const userTransferLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,   // 5 minute window
  max: 10,                    // 10 transaction attempts per 5 min per user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      try {
        const payload = JSON.parse(Buffer.from(auth.slice(7).split('.')[1], 'base64').toString());
        if (payload?.sub) return `uid:${payload.sub}`;
      } catch { /* fall through */ }
    }
    return `ip:${req.ip}`;
  },
  message: { success: false, message: 'Transaction rate limit reached. Max 10 per 5 minutes.', code: 'RATE_LIMITED' },
});
