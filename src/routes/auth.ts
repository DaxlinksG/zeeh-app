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
import { createUser, getUserByEmail, getUserById, verifyPassword, touchLastLogin, generateOtp, storeOtp, verifyOtp, storePasswordResetToken, verifyPasswordResetToken, resetPassword } from '../lib/userStore';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  decodeRefreshJti,
} from '../lib/jwtHelper';
import { sendWelcomeOtp, sendOtpResend, sendEmailVerified, sendPasswordReset } from '../lib/mailer';
import { sendOtpSms } from '../lib/sms';

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

    // Generate + send OTP via email + SMS (fire-and-forget)
    const otp = generateOtp();
    await storeOtp(user.user_id, otp);
    sendWelcomeOtp(user.email, user.first_name, otp);           // email — non-blocking
    if (user.phone) sendOtpSms(user.phone, otp, user.first_name); // SMS  — non-blocking

    const [accessToken, refreshToken] = await Promise.all([
      signAccessToken({ sub: user.user_id, email: user.email, kyc_status: user.kyc_status, email_verified: false }),
      signRefreshToken(user.user_id),
    ]);

    res.status(201).json({
      success: true,
      message: 'Account created. Check your email for a verification code.',
      data: {
        access_token:   accessToken,
        refresh_token:  refreshToken,
        email_verified: false,
        user: {
          user_id:        user.user_id,
          email:          user.email,
          first_name:     user.first_name,
          last_name:      user.last_name,
          kyc_status:     user.kyc_status,
          email_verified: false,
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
      signAccessToken({ sub: user.user_id, email: user.email, kyc_status: user.kyc_status, email_verified: user.email_verified ?? false }),
      signRefreshToken(user.user_id),
      touchLastLogin(user.user_id),
    ]);

    res.json({
      success: true,
      data: {
        access_token:  accessToken,
        refresh_token: refreshToken,
        user: {
          user_id:        user.user_id,
          email:          user.email,
          first_name:     user.first_name,
          last_name:      user.last_name,
          kyc_status:     user.kyc_status,
          email_verified: user.email_verified ?? false,
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
      signAccessToken({ sub: user.user_id, email: user.email, kyc_status: user.kyc_status, email_verified: user.email_verified ?? false }),
      signRefreshToken(user.user_id),
    ]);

    // Return updated user object so the client can sync kyc_status / email_verified
    // without requiring a full logout/login cycle.
    res.json({
      success: true,
      data: {
        access_token:  accessToken,
        refresh_token: refreshToken,
        user: {
          user_id:        user.user_id,
          email:          user.email,
          first_name:     user.first_name,
          last_name:      user.last_name,
          kyc_status:     user.kyc_status,
          email_verified: user.email_verified ?? false,
        },
      },
    });
  } catch (err: unknown) {
    if ((err as Error).message === 'TOKEN_REVOKED' || (err as { name?: string }).name === 'JsonWebTokenError') {
      res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
      return;
    }
    next(err);
  }
});

// ── Verify Email (OTP) ─────────────────────────────────────────────────────
const verifyEmailSchema = z.object({ otp: z.string().length(6) });

router.post('/verify-email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Must be authenticated — read user_id from Bearer token claim
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Authorization required' });
      return;
    }

    // Lightweight decode (no verify — the auth middleware on protected routes does full verify)
    let userId: string;
    try {
      const { verifyAccessToken } = await import('../lib/jwtHelper');
      const payload = await verifyAccessToken(authHeader.slice(7));
      userId = payload.sub as string;
    } catch {
      res.status(401).json({ success: false, message: 'Invalid or expired token' });
      return;
    }

    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'A 6-digit OTP is required' });
      return;
    }

    const result = await verifyOtp(userId, parsed.data.otp);

    if (result === 'locked') {
      res.status(429).json({ success: false, message: 'Too many attempts. Request a new code.' });
      return;
    }
    if (result === 'expired') {
      res.status(410).json({ success: false, message: 'Code has expired. Request a new one.' });
      return;
    }
    if (result === 'invalid') {
      res.status(400).json({ success: false, message: 'Incorrect code' });
      return;
    }

    // result === 'ok'
    const user = await getUserById(userId);
    if (user) sendEmailVerified(user.email, user.first_name); // non-blocking

    res.json({ success: true, message: 'Email verified successfully' });
  } catch (err) {
    next(err);
  }
});

// ── Resend OTP ─────────────────────────────────────────────────────────────
router.post('/resend-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Authorization required' });
      return;
    }

    let userId: string;
    try {
      const { verifyAccessToken } = await import('../lib/jwtHelper');
      const payload = await verifyAccessToken(authHeader.slice(7));
      userId = payload.sub as string;
    } catch {
      res.status(401).json({ success: false, message: 'Invalid or expired token' });
      return;
    }

    const user = await getUserById(userId);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    if (user.email_verified) {
      res.status(400).json({ success: false, message: 'Email is already verified' });
      return;
    }

    // Per-user resend cooldown (60 s) — prevents an attacker from using rotating
    // IPs to repeatedly reset the OTP attempt counter and brute-force the code.
    const OTP_TTL_SECONDS = 10 * 60; // must match userStore constant
    const OTP_RESEND_COOLDOWN_S = 60;
    const OTP_MAX_RESENDS_PER_HOUR = 5;

    if (user.otp_expires) {
      const requestedAt = user.otp_expires - OTP_TTL_SECONDS; // Unix timestamp when last OTP was issued
      const secondsSince = Math.floor(Date.now() / 1000) - requestedAt;
      if (secondsSince < OTP_RESEND_COOLDOWN_S) {
        res.status(429).json({
          success: false,
          message: `Please wait ${OTP_RESEND_COOLDOWN_S - secondsSince} second(s) before requesting a new code.`,
          code:    'RESEND_TOO_FAST',
        });
        return;
      }
      // Hourly cap — otp_resend_count is incremented on each resend and cleared with a new OTP
      const resendCount = user.otp_attempts ?? 0; // reuse otp_attempts as resend counter pre-OTP
      // We approximate the hourly window as: if requestedAt < now-3600, it's a new hour
      const isNewHour = secondsSince >= 3600;
      if (!isNewHour && resendCount >= OTP_MAX_RESENDS_PER_HOUR) {
        res.status(429).json({
          success: false,
          message: 'You have requested too many verification codes. Please wait an hour before trying again.',
          code:    'RESEND_LIMIT_REACHED',
        });
        return;
      }
    }

    const otp = generateOtp();
    await storeOtp(user.user_id, otp);
    sendOtpResend(user.email, user.first_name, otp);              // email — non-blocking
    if (user.phone) sendOtpSms(user.phone, otp, user.first_name); // SMS  — non-blocking

    res.json({ success: true, message: 'A new verification code has been sent to your email' });
  } catch (err) {
    next(err);
  }
});

// ── Forgot Password ────────────────────────────────────────────────────────
// Always returns 200 to prevent user enumeration — don't reveal if the email exists.
router.post('/forgot-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = z.string().email().safeParse(req.body?.email);
    if (!email.success) {
      res.status(400).json({ success: false, message: 'A valid email address is required' }); return;
    }

    const user = await getUserByEmail(email.data);
    if (user && user.is_active) {
      const token  = require('crypto').randomBytes(32).toString('hex');
      const appUrl = process.env.APP_URL ?? 'https://app.zeehfi.ca';
      const resetUrl = `${appUrl}/reset-password?uid=${encodeURIComponent(user.user_id)}&token=${encodeURIComponent(token)}`;

      await storePasswordResetToken(user.user_id, token);
      sendPasswordReset(user.email, user.first_name, resetUrl); // fire-and-forget
    }

    // Always same response — prevents leaking whether email is registered
    res.json({ success: true, message: 'If that email is registered you will receive a reset link shortly.' });
  } catch (err) { next(err); }
});

// ── Reset Password ─────────────────────────────────────────────────────────
const resetPasswordSchema = z.object({
  user_id:      z.string().min(1),
  token:        z.string().min(1),
  new_password: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Validation error', errors: parsed.error.flatten() }); return;
    }
    const { user_id, token, new_password } = parsed.data;

    const result = await verifyPasswordResetToken(user_id, token);

    if (result === 'expired') {
      res.status(410).json({ success: false, message: 'Reset link has expired. Please request a new one.', code: 'TOKEN_EXPIRED' }); return;
    }
    if (result === 'invalid') {
      res.status(400).json({ success: false, message: 'Invalid reset link.', code: 'TOKEN_INVALID' }); return;
    }

    // Revoke all existing refresh tokens by updating the password (all active sessions become invalid)
    await resetPassword(user_id, new_password);

    res.json({ success: true, message: 'Password updated. Please log in with your new password.' });
  } catch (err) { next(err); }
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
