/**
 * userAuth middleware — protects /me/* routes
 *
 * Reads Bearer token from Authorization header, verifies the access JWT,
 * and attaches req.user to the request.
 */

import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/jwtHelper';
import { verifyTransactionPin } from '../lib/userStore';

declare global {
  namespace Express {
    interface Request {
      user?: {
        user_id:        string;
        email:          string;
        kyc_status:     string;
        email_verified: boolean;
      };
    }
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Missing authorization token' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyAccessToken(token);
    req.user = {
      user_id:        payload.sub,
      email:          payload.email,
      kyc_status:     payload.kyc_status,
      email_verified: payload.email_verified ?? false,
    };
    next();
  } catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('expired')) {
      res.status(401).json({ success: false, message: 'Token expired', code: 'TOKEN_EXPIRED' });
    } else {
      res.status(401).json({ success: false, message: 'Invalid token' });
    }
  }
}

// Blocks unverified accounts from making financial transactions.
// Profile reads, deposit instructions, and rates remain accessible.
export function requireEmailVerified(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.email_verified) {
    res.status(403).json({
      success: false,
      message: 'Please verify your email address before making transactions. Check your inbox for the verification code.',
      code: 'EMAIL_NOT_VERIFIED',
    });
    return;
  }
  next();
}

// Requires KYC approved for external transfers
export function requireKyc(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.kyc_status !== 'approved') {
    res.status(403).json({
      success: false,
      message: 'KYC verification required to perform this action',
      code: 'KYC_REQUIRED',
    });
    return;
  }
  next();
}

// Transaction PIN gate — must appear AFTER requireUser in the middleware chain.
//
// Reads req.body.pin, verifies against the stored bcrypt hash, then DELETES
// it from req.body so downstream handlers and audit logs never see it.
// Tracks per-user failures; 5 consecutive wrong PINs trigger a 15-min lockout.
export function requirePin(req: Request, res: Response, next: NextFunction): void {
  const raw = String(req.body?.pin ?? '').replace(/\D/g, '');

  // Strip from body immediately — must happen whether valid or not
  if (req.body) delete req.body.pin;

  if (!raw || raw.length !== 4) {
    res.status(400).json({
      success: false,
      message: 'A 4-digit transaction PIN is required',
      code:    'PIN_REQUIRED',
    });
    return;
  }

  verifyTransactionPin(req.user!.user_id, raw)
    .then(result => {
      switch (result) {
        case 'ok':
          next();
          break;
        case 'no_pin':
          res.status(403).json({
            success: false,
            message: 'Set a transaction PIN first — go to Profile → Security.',
            code:    'PIN_NOT_SET',
          });
          break;
        case 'locked':
          res.status(429).json({
            success: false,
            message: 'Too many incorrect PIN attempts. Your PIN is locked for 15 minutes.',
            code:    'PIN_LOCKED',
          });
          break;
        default:
          res.status(403).json({
            success: false,
            message: 'Incorrect PIN. Please try again.',
            code:    'INCORRECT_PIN',
          });
      }
    })
    .catch(next);
}
