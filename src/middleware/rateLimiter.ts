import rateLimit from 'express-rate-limit';

// General API rate limit — all /api/* routes
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 120,                   // 120 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests — please slow down.' },
  skip: (req) => req.path === '/health',
});

// Strict limiter for money-moving endpoints (transfers + swaps)
export const transferLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 20,                    // 20 transfer/swap attempts per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Transfer rate limit exceeded. Max 20 per minute.' },
});

// Looser limiter for rate/quote lookups (customers poll frequently)
export const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,                   // 300 quote requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Rate lookup limit exceeded.' },
});
