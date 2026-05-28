/**
 * userAuth middleware — protects /me/* routes
 *
 * Reads Bearer token from Authorization header, verifies the access JWT,
 * and attaches req.user to the request.
 */

import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/jwtHelper';

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
