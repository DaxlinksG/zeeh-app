/**
 * Auth routes — public, no API key required
 *
 * POST /auth/register
 * POST /auth/login
 * POST /auth/refresh
 * POST /auth/logout
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createUser, getUserByEmail, verifyPassword, touchLastLogin } from '../lib/userStore';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  decodeRefreshJti,
} from '../lib/jwtHelper';

const router = Router();

// ── Register ───────────────────────────────────────────────────────────────
const registerSchema = z.object({
  email:      z.string().email(),
  password:   z.string().min(8, 'Password must be at least 8 characters'),
  first_name: z.string().min(1).max(60),
  last_name:  z.string().min(1).max(60),
  phone:      z.string().min(7).max(20),
  country:    z.string().min(2).max(60),
});

router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Validation error', errors: parsed.error.flatten() });
      return;
    }
    const { email, password, first_name, last_name, phone, country } = parsed.data;

    const user = await createUser(email, password, first_name, last_name, phone, country);

    const [accessToken, refreshToken] = await Promise.all([
      signAccessToken({ sub: user.user_id, email: user.email, kyc_status: user.kyc_status }),
      signRefreshToken(user.user_id),
    ]);

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: {
        access_token:  accessToken,
        refresh_token: refreshToken,
        user: {
          user_id:    user.user_id,
          email:      user.email,
          first_name: user.first_name,
          last_name:  user.last_name,
          kyc_status: user.kyc_status,
        },
      },
    });
  } catch (err: unknown) {
    if ((err as Error).message === 'EMAIL_EXISTS') {
      res.status(409).json({ success: false, message: 'An account with this email already exists' });
      return;
    }
    next(err);
  }
});

// ── Login ──────────────────────────────────────────────────────────────────
const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Email and password are required' });
      return;
    }

    const user = await getUserByEmail(parsed.data.email);
    const valid = user && await verifyPassword(user, parsed.data.password);

    if (!valid || !user) {
      res.status(401).json({ success: false, message: 'Invalid email or password' });
      return;
    }

    if (!user.is_active) {
      res.status(403).json({ success: false, message: 'Account is suspended' });
      return;
    }

    const [accessToken, refreshToken] = await Promise.all([
      signAccessToken({ sub: user.user_id, email: user.email, kyc_status: user.kyc_status }),
      signRefreshToken(user.user_id),
      touchLastLogin(user.user_id),
    ]);

    res.json({
      success: true,
      data: {
        access_token:  accessToken,
        refresh_token: refreshToken,
        user: {
          user_id:    user.user_id,
          email:      user.email,
          first_name: user.first_name,
          last_name:  user.last_name,
          kyc_status: user.kyc_status,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Refresh ────────────────────────────────────────────────────────────────
const refreshSchema = z.object({ refresh_token: z.string().min(1) });

router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'refresh_token required' });
      return;
    }

    const payload = await verifyRefreshToken(parsed.data.refresh_token);

    // Rotate: revoke old, issue new pair
    await revokeRefreshToken(payload.jti);

    const { getUserById } = await import('../lib/userStore');
    const user = await getUserById(payload.sub);
    if (!user || !user.is_active) {
      res.status(401).json({ success: false, message: 'Account not found or suspended' });
      return;
    }

    const [accessToken, refreshToken] = await Promise.all([
      signAccessToken({ sub: user.user_id, email: user.email, kyc_status: user.kyc_status }),
      signRefreshToken(user.user_id),
    ]);

    res.json({ success: true, data: { access_token: accessToken, refresh_token: refreshToken } });
  } catch (err: unknown) {
    if ((err as Error).message === 'TOKEN_REVOKED' || (err as { name?: string }).name === 'JsonWebTokenError') {
      res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
      return;
    }
    next(err);
  }
});

// ── Logout ─────────────────────────────────────────────────────────────────
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const token = req.body?.refresh_token as string | undefined;
    if (token) {
      const jti = decodeRefreshJti(token);
      if (jti) await revokeRefreshToken(jti);
    }
  } catch { /* ignore */ }
  res.json({ success: true, message: 'Logged out' });
});

export default router;
