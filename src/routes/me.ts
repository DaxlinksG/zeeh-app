/**
 * /me/* routes — authenticated end-user actions
 *
 * GET  /me/profile
 * PUT  /me/profile
 * POST /me/kyc
 * GET  /me/balance
 * GET  /me/balance/:currency
 * GET  /me/transactions
 * GET  /me/deposit
 * GET  /me/rates
 * GET  /me/users/search?email=
 * POST /me/send          — P2P internal transfer
 * POST /me/transfer      — off-ramp bank transfer (KYC required)
 * POST /me/swap          — currency swap (KYC required)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import axios from 'axios';
import {
  getUserById, getUserByEmail,
  updateUserProfile, getKyc,
  setTransactionPin, verifyTransactionPin, hasPinSet,
} from '../lib/userStore';
import {
  getCreditRecord, saveCreditRecord, decryptBvn, encryptBvn,
  type NigerianCreditReport, type CreditRecord,
} from '../lib/creditStore';
import { storeKycSession } from '../lib/kycSessionStore';
import {
  addBeneficiary, getBeneficiaries, isBeneficiary, removeBeneficiary,
} from '../lib/beneficiaryStore';
import {
  getBalance, getAllBalances, getTransactions,
  debitBalance, creditBalance, refundBalance,
  findTransactionByReference,
  InsufficientBalanceError,
} from '../lib/ledger';
import { gtp } from '../lib/gtpClient';
import { buildQuote, calcConversion } from '../lib/spreadEngine';
import { listDepositInstructions } from '../lib/depositConfig';
import { requireKyc, requireEmailVerified, requirePin } from '../middleware/userAuth';
import { userTransferLimiter } from '../middleware/rateLimiter';
import { auditLog } from '../middleware/logger';
import {
  sendMoneySent, sendMoneyReceived,
  sendSwapCompleted,
  sendTransferInitiated,
} from '../lib/mailer';
import {
  sendMoneyReceivedSms, sendMoneySentSms,
  sendSwapSms, sendTransferInitiatedSms,
} from '../lib/sms';
import { assertNotFrozen, FrozenCurrencyError } from '../lib/circuitBreaker';

const router = Router();

// ── Per-transaction amount ceiling ─────────────────────────────────────────
// MAX_TXN_AMOUNT is denominated in the transaction currency.
// Default 10,000 — set MAX_TXN_AMOUNT in env to adjust per environment.
// This caps single-transaction exposure in case an account is compromised.
const MAX_TXN_AMOUNT = parseFloat(process.env.MAX_TXN_AMOUNT ?? '10000');

function checkAmountCap(amount: string, res: Response): boolean {
  if (parseFloat(amount) > MAX_TXN_AMOUNT) {
    res.status(400).json({
      success: false,
      message: `Transaction amount exceeds the per-transaction limit of ${MAX_TXN_AMOUNT}. Please contact support for higher limits.`,
      code:    'AMOUNT_EXCEEDS_LIMIT',
    });
    return false;
  }
  return true;
}

// ── Profile ────────────────────────────────────────────────────────────────
router.get('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getUserById(req.user!.user_id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const kyc = await getKyc(user.user_id);
    res.json({
      success: true,
      data: {
        user_id:        user.user_id,
        email:          user.email,
        first_name:     user.first_name,
        last_name:      user.last_name,
        phone:          user.phone,
        country:        user.country,
        kyc_status:     user.kyc_status,
        email_verified: user.email_verified ?? false,
        has_pin:        !!user.transaction_pin_hash,
        created_at:     user.created_at,
        kyc: kyc ? {
          date_of_birth: kyc.date_of_birth,
          nationality:   kyc.nationality,
          id_type:       kyc.id_type,
          submitted_at:  kyc.submitted_at,
        } : null,
      },
    });
  } catch (err) { next(err); }
});

const updateProfileSchema = z.object({
  phone:   z.string().min(7).max(20).optional(),
  country: z.string().min(2).max(60).optional(),
});

router.put('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }
    await updateUserProfile(req.user!.user_id, parsed.data);
    res.json({ success: true, message: 'Profile updated' });
  } catch (err) { next(err); }
});

// ── KYC ────────────────────────────────────────────────────────────────────
//
// Delegates entirely to the standalone KYC service at kyc.zeehfi.ca.
//
// Flow:
//   1. App calls POST /me/kyc/start → backend creates a session at kyc.zeehfi.ca
//      and returns a widget_url for the frontend to open.
//   2. User completes verification inside the widget (doc scan + liveness).
//   3. kyc.zeehfi.ca fires a webhook to POST /webhooks/kyc (handled in index.ts).
//   4. Webhook handler updates the user's kyc_status in DynamoDB.
//
router.post('/kyc/start', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const kycApiKey = process.env.KYC_API_KEY;
    const kycBase   = process.env.KYC_SERVICE_URL ?? 'https://kyc.zeehfi.ca';
    if (!kycApiKey) {
      res.status(500).json({ success: false, message: 'KYC service not configured' }); return;
    }

    // Always read from DB — the JWT kyc_status can be stale if a webhook fired since login
    const u = await getUserById(req.user!.user_id);
    if (!u) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    if (u.kyc_status === 'approved') {
      res.status(400).json({ success: false, message: 'KYC already approved', code: 'KYC_APPROVED' }); return;
    }
    if (u.kyc_status === 'pending') {
      res.status(400).json({ success: false, message: 'Your verification is already under review. Please wait for the result.', code: 'KYC_PENDING' }); return;
    }

    // After KYC is complete, redirect the user back to the app's profile page.
    const appOrigin = process.env.APP_ORIGIN ?? 'https://app.zeehfi.ca';
    const redirectUrl = `${appOrigin}/profile?kyc_done=1`;

    // Pass the user's ID in both naming conventions — their API docs say externalId
    // (camelCase) but their system stores it as external_id (snake_case). Send both
    // so it maps regardless of which field they actually read server-side.
    const sessionBody = {
      externalId:  u.user_id,   // camelCase — per their API docs
      external_id: u.user_id,   // snake_case — what their DB actually stores
      metadata:    { email: u.email, first_name: u.first_name, last_name: u.last_name },
      redirect_url: redirectUrl,
    };
    console.log(`🪪  KYC session create — user=${u.user_id} body=${JSON.stringify(sessionBody)}`);

    const { data: session } = await axios.post(
      `${kycBase}/v1/sessions`,
      sessionBody,
      {
        headers: { Authorization: `Bearer ${kycApiKey}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      },
    );
    console.log(`🪪  KYC session response — ${JSON.stringify(session)}`);

    // Build the full verify URL — user navigates here to complete KYC
    const verifyUrl = `${kycBase}/verify?session_token=${session.session_token ?? session.data?.session_token}`;

    // Store session_id → user_id in our own DB so the webhook handler can
    // resolve the user regardless of whether the KYC provider passes external_id.
    const resolvedSessionId = session.session_id ?? session.data?.session_id;
    if (resolvedSessionId) {
      storeKycSession(resolvedSessionId, u.user_id).catch(e =>
        console.error('⚠️  Failed to store KYC session mapping:', e),
      );
    }

    auditLog('kyc.session_started', req, { session_id: resolvedSessionId });

    res.json({
      success: true,
      data: {
        session_id: resolvedSessionId,
        verify_url: verifyUrl,
        expires_at: session.expires_at,
      },
    });
  } catch (err) { next(err); }
});

// ── KYC document upload proxy ─────────────────────────────────────────────
// Receives a base64 image from the frontend and forwards it as multipart to
// kyc.zeehfi.ca. This proxy avoids exposing the KYC API key to the browser
// and sidesteps cross-origin restrictions on the KYC service.
//
// Body: { session_id, session_token, document_type, side?, image }
//   image: data URL — "data:image/jpeg;base64,..."
//
router.post('/kyc/upload-doc', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session_id, session_token, document_type, side, image } = req.body ?? {};

    if (!session_id || !session_token || !document_type || !image) {
      res.status(400).json({ success: false, message: 'session_id, session_token, document_type, and image are required' }); return;
    }
    const validTypes = ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENSE'];
    if (!validTypes.includes(document_type)) {
      res.status(400).json({ success: false, message: `document_type must be one of: ${validTypes.join(', ')}` }); return;
    }

    // Decode base64 data URL → Buffer
    const match = String(image).match(/^data:([^;]+);base64,(.+)$/);
    if (!match) { res.status(400).json({ success: false, message: 'image must be a base64 data URL' }); return; }
    const [, mimeType, b64] = match;
    const buffer = Buffer.from(b64, 'base64');

    // Build multipart form and forward to KYC service
    const kycBase = process.env.KYC_SERVICE_URL ?? 'https://kyc.zeehfi.ca';
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), 'document.jpg');
    form.append('document_type', document_type);
    if (side) form.append('side', side);

    const { data } = await axios.post(
      `${kycBase}/v1/sessions/${session_id}/documents`,
      form,
      { headers: { Authorization: `Bearer ${session_token}` }, timeout: 30000 },
    );

    auditLog('kyc.doc_uploaded', req, { session_id, document_type, side: side ?? 'FRONT' });
    res.json({ success: true, data });
  } catch (err: unknown) {
    const status = axios.isAxiosError(err) ? (err.response?.status ?? 502) : 502;
    const message = axios.isAxiosError(err) ? (err.response?.data?.message ?? 'Document upload failed') : 'Document upload failed';
    res.status(status).json({ success: false, message });
  }
});

// ── KYC selfie upload proxy ───────────────────────────────────────────────
// Body: { session_id, session_token, image }
//
router.post('/kyc/upload-selfie', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session_id, session_token, image } = req.body ?? {};

    if (!session_id || !session_token || !image) {
      res.status(400).json({ success: false, message: 'session_id, session_token, and image are required' }); return;
    }

    const match = String(image).match(/^data:([^;]+);base64,(.+)$/);
    if (!match) { res.status(400).json({ success: false, message: 'image must be a base64 data URL' }); return; }
    const [, mimeType, b64] = match;
    const buffer = Buffer.from(b64, 'base64');

    const kycBase = process.env.KYC_SERVICE_URL ?? 'https://kyc.zeehfi.ca';
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), 'selfie.jpg');

    const { data } = await axios.post(
      `${kycBase}/v1/sessions/${session_id}/selfie`,
      form,
      { headers: { Authorization: `Bearer ${session_token}` }, timeout: 30000 },
    );

    auditLog('kyc.selfie_uploaded', req, { session_id });
    res.json({ success: true, data });
  } catch (err: unknown) {
    const status = axios.isAxiosError(err) ? (err.response?.status ?? 502) : 502;
    const message = axios.isAxiosError(err) ? (err.response?.data?.message ?? 'Selfie upload failed') : 'Selfie upload failed';
    res.status(status).json({ success: false, message });
  }
});

// ── Balance ────────────────────────────────────────────────────────────────
router.get('/balance', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const balances = await getAllBalances(req.user!.user_id);
    res.json({ success: true, data: { balances: balances.map(b => ({
      currency: b.currency, balance: b.balance, available: b.available,
      reserved: b.reserved, updated_at: b.updated_at,
    })) } });
  } catch (err) { next(err); }
});

router.get('/balance/:currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const balance = await getBalance(req.user!.user_id, req.params.currency.toUpperCase());
    res.json({ success: true, data: { currency: balance.currency, balance: balance.balance, available: balance.available, reserved: balance.reserved } });
  } catch (err) { next(err); }
});

// ── Transactions ───────────────────────────────────────────────────────────
router.get('/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string ?? '50', 10), 200);
    const txns  = await getTransactions(req.user!.user_id, limit);
    res.json({ success: true, data: { transactions: txns, count: txns.length } });
  } catch (err) { next(err); }
});

// ── Deposit instructions ───────────────────────────────────────────────────
// Merges admin-configured instructions (per currency) with GTP wallet data.
// Admin-configured entries take full priority; GTP wallets fill in any gap.
router.get('/deposit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Admin-configured instructions (from DynamoDB)
    const configured = await listDepositInstructions();
    const configMap  = new Map(configured.map(c => [c.currency.toUpperCase(), c]));

    // 2. GTP wallets (best-effort — don't fail if GTP is down)
    let gtpMap = new Map<string, Record<string, unknown>>();
    try {
      const { data } = await gtp.get('/wallets');
      const d = data.data;
      let rawWallets: Record<string, unknown>[] = [];
      if (Array.isArray(d))               rawWallets = d;
      else if (Array.isArray(d?.wallets)) rawWallets = d.wallets;
      else if (Array.isArray(data))        rawWallets = data;

      for (const w of rawWallets) {
        const cur  = w.currency as Record<string, unknown> | string | undefined;
        const code = (typeof cur === 'object' && cur !== null)
          ? String((cur as Record<string, unknown>).code ?? '').toUpperCase()
          : String(cur ?? '').toUpperCase();
        if (code && code !== '[OBJECT OBJECT]') gtpMap.set(code, w);
      }
    } catch { /* GTP unavailable — still serve admin-configured instructions */ }

    // 3. Merge: start with admin instructions, add any GTP-only currencies
    const allCurrencies = new Set([...configMap.keys(), ...gtpMap.keys()]);
    const instructions = Array.from(allCurrencies).map(code => {
      const admin = configMap.get(code);
      const w     = gtpMap.get(code);

      if (admin) {
        // Admin config is the source of truth; optionally pull wallet_id from GTP
        return {
          currency:       admin.currency,
          bank_name:      admin.bank_name,
          account_name:   admin.account_name,
          account_number: admin.account_number,
          iban:           admin.iban,
          swift:          admin.swift,
          sort_code:      admin.sort_code,
          send_to_email:  admin.send_to_email,
          wallet_id:      admin.wallet_id ?? (w ? String(w.wallet_id ?? w.id ?? '') : ''),
        };
      }

      // GTP-only wallet (no admin config)
      const details = (w!.user_bank_details as Record<string, unknown> | undefined) ?? w!;
      return {
        currency:       code,
        bank_name:      details.bank_name,
        account_name:   details.account_name,
        account_number: details.account_number,
        iban:           details.iban,
        swift:          details.swift,
        sort_code:      details.sort_code,
        send_to_email:  details.send_to_email ?? (code === 'CAD' ? details.account_number : undefined),
        wallet_id:      String(w!.wallet_id ?? w!.id ?? ''),
      };
    }).filter(i => i.currency);

    res.json({
      success: true,
      data: {
        instructions,
        note: 'Send funds to the account details above. Your balance will be credited once confirmed.',
      },
    });
  } catch (err) { next(err); }
});

// ── Exchange rates ─────────────────────────────────────────────────────────
router.get('/rates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const from = String(req.query.from ?? '').toUpperCase();
    const to   = String(req.query.to   ?? '').toUpperCase();
    if (!from || !to) {
      res.status(400).json({ success: false, message: '?from=USD&to=NGN query params required' }); return;
    }
    let entry: { buy_rate: string; updated_at: string; timestamp: string };
    try {
      const rateRes = await gtp.get(`/rates/${from}/${to}`);
      entry = rateRes.data.data as typeof entry;
    } catch {
      res.status(422).json({ success: false, message: `Rate not available for ${from}/${to}. This pair may not be supported by Expedier.` }); return;
    }
    const rawRate = parseFloat(entry.buy_rate ?? '0');
    if (!rawRate || isNaN(rawRate)) {
      res.status(422).json({ success: false, message: `Rate data missing for ${from}/${to}` }); return;
    }
    const quote = buildQuote(from, to, rawRate, entry.timestamp, entry.updated_at, 'live_market');
    res.json({
      success: true,
      data: {
        from, to,
        rate:       quote.customerRate,
        updated_at: entry.updated_at,
      },
    });
  } catch (err) { next(err); }
});

// ── Find user (P2P send target) ────────────────────────────────────────────
router.get('/users/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = String(req.query.email ?? '').toLowerCase().trim();
    if (!email) { res.status(400).json({ success: false, message: '?email= required' }); return; }

    const user = await getUserByEmail(email);
    if (!user || user.user_id === req.user!.user_id) {
      res.status(404).json({ success: false, message: 'User not found' }); return;
    }
    res.json({
      success: true,
      data: {
        user_id:    user.user_id,
        first_name: user.first_name,
        last_name:  user.last_name,
        email:      user.email,
      },
    });
  } catch (err) { next(err); }
});

// ── Transaction PIN management ─────────────────────────────────────────────

// Set PIN for the first time (no existing PIN must be present)
router.post('/pin/set', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { pin } = req.body ?? {};
    const cleanPin = String(pin ?? '').replace(/\D/g, '');
    if (cleanPin.length !== 4) {
      res.status(400).json({ success: false, message: 'PIN must be exactly 4 digits', code: 'INVALID_PIN' }); return;
    }
    if (await hasPinSet(req.user!.user_id)) {
      res.status(409).json({ success: false, message: 'A PIN is already set. Use /me/pin/change to update it.', code: 'PIN_ALREADY_SET' }); return;
    }
    await setTransactionPin(req.user!.user_id, cleanPin);
    res.json({ success: true, message: 'Transaction PIN set successfully' });
  } catch (err) { next(err); }
});

// Change existing PIN — requires the current PIN as second factor
router.post('/pin/change', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { current_pin, new_pin } = req.body ?? {};
    const currentClean = String(current_pin ?? '').replace(/\D/g, '');
    const newClean     = String(new_pin     ?? '').replace(/\D/g, '');

    if (newClean.length !== 4) {
      res.status(400).json({ success: false, message: 'New PIN must be exactly 4 digits', code: 'INVALID_PIN' }); return;
    }

    const result = await verifyTransactionPin(req.user!.user_id, currentClean);
    if (result === 'no_pin') {
      res.status(400).json({ success: false, message: 'No PIN set yet. Use /me/pin/set first.', code: 'PIN_NOT_SET' }); return;
    }
    if (result === 'locked') {
      res.status(429).json({ success: false, message: 'Too many incorrect PIN attempts. Try again in 15 minutes.', code: 'PIN_LOCKED' }); return;
    }
    if (result === 'invalid') {
      res.status(403).json({ success: false, message: 'Current PIN is incorrect', code: 'INCORRECT_PIN' }); return;
    }

    await setTransactionPin(req.user!.user_id, newClean);
    res.json({ success: true, message: 'Transaction PIN updated successfully' });
  } catch (err) { next(err); }
});

// Reset PIN using account password (for forgot-PIN scenario)
router.post('/pin/reset', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { password, new_pin } = req.body ?? {};
    const newClean = String(new_pin ?? '').replace(/\D/g, '');

    if (newClean.length !== 4) {
      res.status(400).json({ success: false, message: 'New PIN must be exactly 4 digits', code: 'INVALID_PIN' }); return;
    }

    const { verifyPassword } = await import('../lib/userStore');
    const user = await getUserById(req.user!.user_id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const validPassword = await verifyPassword(user, String(password ?? ''));
    if (!validPassword) {
      res.status(403).json({ success: false, message: 'Incorrect password', code: 'INCORRECT_PASSWORD' }); return;
    }

    await setTransactionPin(req.user!.user_id, newClean);
    res.json({ success: true, message: 'Transaction PIN reset successfully' });
  } catch (err) { next(err); }
});

// ── Beneficiaries ──────────────────────────────────────────────────────────

router.get('/beneficiaries', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const beneficiaries = await getBeneficiaries(req.user!.user_id);
    res.json({ success: true, data: { beneficiaries } });
  } catch (err) { next(err); }
});

router.post('/beneficiaries', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body ?? {};
    if (!email) { res.status(400).json({ success: false, message: 'email is required' }); return; }

    const target = await getUserByEmail(String(email));
    if (!target) { res.status(404).json({ success: false, message: 'No Zeeh user found with that email' }); return; }
    if (target.user_id === req.user!.user_id) {
      res.status(400).json({ success: false, message: 'You cannot add yourself as a beneficiary' }); return;
    }

    await addBeneficiary(req.user!.user_id, {
      beneficiary_id: target.user_id,
      email:          target.email,
      first_name:     target.first_name,
      last_name:      target.last_name,
    }).catch((err: unknown) => {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw Object.assign(new Error('Already saved'), { _status: 409, _code: 'ALREADY_BENEFICIARY' });
      }
      throw err;
    });

    res.status(201).json({
      success: true,
      message: `${target.first_name} ${target.last_name} saved as a beneficiary`,
      data: {
        beneficiary_id: target.user_id,
        email:          target.email,
        first_name:     target.first_name,
        last_name:      target.last_name,
      },
    });
  } catch (err: unknown) {
    const e = err as { _status?: number; _code?: string; message?: string };
    if (e._status) {
      res.status(e._status).json({ success: false, message: e.message, code: e._code }); return;
    }
    next(err);
  }
});

router.delete('/beneficiaries/:beneficiary_id', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await removeBeneficiary(req.user!.user_id, req.params.beneficiary_id);
    res.json({ success: true, message: 'Beneficiary removed' });
  } catch (err) { next(err); }
});

// ── P2P Send ───────────────────────────────────────────────────────────────
const sendSchema = z.object({
  recipient_email: z.string().email(),
  currency:        z.string().length(3).toUpperCase(),
  amount:          z.string().regex(/^\d+(\.\d{1,2})?$/),
  note:            z.string().max(255).optional(),
});

router.post('/send', requireEmailVerified, requirePin, userTransferLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }
    const { recipient_email, currency, amount, note } = parsed.data;
    const senderId = req.user!.user_id;

    if (!checkAmountCap(amount, res)) return;

    // Circuit breaker — block if this currency's outflows are frozen
    try { await assertNotFrozen(currency); } catch (e) {
      if (e instanceof FrozenCurrencyError)
        return void res.status(503).json({ success: false, message: `${currency} transfers are temporarily suspended for maintenance. Please try again later.`, code: 'CURRENCY_FROZEN' });
      throw e;
    }

    const recipient = await getUserByEmail(recipient_email);
    if (!recipient) {
      res.status(404).json({ success: false, message: 'Recipient not found' }); return;
    }
    if (recipient.user_id === senderId) {
      res.status(400).json({ success: false, message: 'Cannot send to yourself' }); return;
    }

    // Beneficiary gate — sender must have explicitly saved this recipient
    const trusted = await isBeneficiary(senderId, recipient.user_id);
    if (!trusted) {
      res.status(403).json({
        success: false,
        message: `${recipient.first_name} ${recipient.last_name} is not in your beneficiary list. Add them in Beneficiaries before sending.`,
        code:    'NOT_A_BENEFICIARY',
      }); return;
    }

    const reference = `P2P-${Date.now()}`;
    const desc      = note ? `Payment from ${req.user!.email}: ${note}` : `Payment from ${req.user!.email}`;

    // Debit sender
    try {
      await debitBalance(senderId, currency, amount, 'transfer', reference, `Sent to ${recipient_email}${note ? ': ' + note : ''}`);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        res.status(402).json({ success: false, message: err.message, data: { required: err.required, available: err.available, currency: err.currency } }); return;
      }
      throw err;
    }

    // Credit recipient
    await creditBalance(recipient.user_id, currency, amount, reference, desc).catch(() => {/* reconcile */});

    auditLog('p2p.send', req, { sender: senderId, recipient: recipient.user_id, currency, amount, reference });

    // Email + SMS notifications (fire-and-forget)
    const senderUser = await getUserById(senderId).catch(() => null);
    const senderName = senderUser ? `${senderUser.first_name} ${senderUser.last_name}` : req.user!.email;
    sendMoneySent(req.user!.email, senderUser?.first_name ?? '', recipient.email, currency, amount, reference);
    sendMoneyReceived(recipient.email, recipient.first_name, senderName, currency, amount);
    if (senderUser?.phone)   sendMoneySentSms(senderUser.phone, senderUser.first_name, currency, amount, reference);
    if (recipient.phone)     sendMoneyReceivedSms(recipient.phone, recipient.first_name, senderName, currency, amount);

    res.status(201).json({
      success: true,
      message: `${currency} ${amount} sent to ${recipient.first_name} ${recipient.last_name}`,
      data: { reference, currency, amount, recipient: { first_name: recipient.first_name, last_name: recipient.last_name, email: recipient.email } },
    });
  } catch (err) { next(err); }
});

// ── Bank Transfer (off-ramp) — KYC required ────────────────────────────────
const transferSchema = z.object({
  amount:           z.string().regex(/^\d+(\.\d{1,2})?$/),
  currency:         z.string().length(3).toUpperCase(),
  client_reference: z.string().min(1).max(100),
  description:      z.string().max(255).optional(),
  // NGN
  bank_id:          z.number().int().optional(),
  account_number:   z.string().optional(),
  account_name:     z.string().optional(),
  // CAD
  recipient_email:  z.string().email().optional(),
  // USD
  bank_name:        z.string().optional(),
  routing_number:   z.string().optional(),
  email:            z.string().email().optional(),
  account_type:     z.enum(['checking', 'savings']).optional(),
  address:          z.string().optional(),
  state_id:         z.number().int().optional(),
  city:             z.string().optional(),
  postal_code:      z.string().optional(),
  // Internal P2P
  recipient_uid:    z.string().optional(),
});

router.post('/transfer', requireEmailVerified, requirePin, requireKyc, userTransferLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }
    const { amount, currency, client_reference } = parsed.data;
    const userId = req.user!.user_id;

    if (!checkAmountCap(amount, res)) return;

    // Idempotency guard — reject if this reference was already debited for this user.
    // Prevents double-spend on network retries and accidental duplicate submissions.
    const existingTxn = await findTransactionByReference(userId, client_reference, 'debit');
    if (existingTxn) {
      res.status(409).json({
        success: false,
        message: 'This reference has already been processed. Use a unique client_reference for each transfer.',
        code:    'DUPLICATE_REFERENCE',
        data:    { txn_id: existingTxn.txn_id, processed_at: existingTxn.created_at },
      }); return;
    }

    // Circuit breaker — block outflows for frozen currencies
    try { await assertNotFrozen(currency); } catch (e) {
      if (e instanceof FrozenCurrencyError)
        return void res.status(503).json({ success: false, message: `${currency} transfers are temporarily suspended for maintenance. Please try again later.`, code: 'CURRENCY_FROZEN' });
      throw e;
    }

    // Debit ledger first
    try {
      await debitBalance(userId, currency, amount, 'transfer', client_reference, parsed.data.description ?? `Transfer ${amount} ${currency}`);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        res.status(402).json({ success: false, message: err.message, data: { required: err.required, available: err.available, currency: err.currency } }); return;
      }
      throw err;
    }

    // Forward to GTP — strip internal-only fields before sending upstream
    // recipient_uid is used internally for P2P routing and must not be forwarded to Expedier
    const { recipient_uid: _internalUid, ...gtpPayload } = parsed.data;
    let gtpData;
    try {
      const { data } = await gtp.post('/transfers', gtpPayload);
      gtpData = data;
    } catch (gtpErr) {
      await refundBalance(userId, currency, amount, client_reference, 'GTP transfer failed').catch(() => {});
      throw gtpErr;
    }

    auditLog('user.transfer', req, { user_id: userId, amount, currency, client_reference });

    // Email + SMS notification (fire-and-forget)
    getUserById(userId).then(u => {
      if (!u) return;
      sendTransferInitiated(u.email, u.first_name, currency, amount, client_reference);
      if (u.phone) sendTransferInitiatedSms(u.phone, u.first_name, currency, amount, client_reference);
    }).catch(() => {});

    res.status(201).json(gtpData);
  } catch (err) { next(err); }
});

// ── Swap — KYC required ────────────────────────────────────────────────────
// B2C swaps are settled purely at the ledger level.
// Zeeh manages the actual GTP treasury position separately.
const swapSchema = z.object({
  amount:        z.string().regex(/^\d+(\.\d{1,2})?$/),
  from_currency: z.string().length(3).toUpperCase(),
  to_currency:   z.string().length(3).toUpperCase(),
  reference:     z.string().max(100).optional(),
});

router.post('/swap', requireEmailVerified, requirePin, requireKyc, userTransferLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = swapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }
    const body   = parsed.data;
    const userId = req.user!.user_id;

    if (!checkAmountCap(body.amount, res)) return;

    if (body.from_currency === body.to_currency) {
      res.status(400).json({ success: false, message: 'from_currency and to_currency must differ' }); return;
    }

    // Circuit breaker — block if the source currency outflows are frozen
    try { await assertNotFrozen(body.from_currency); } catch (e) {
      if (e instanceof FrozenCurrencyError)
        return void res.status(503).json({ success: false, message: `${body.from_currency} exchanges are temporarily suspended. Please try again later.`, code: 'CURRENCY_FROZEN' });
      throw e;
    }

    // 1. Fetch live rate from GTP (pricing only — no GTP wallet call)
    //    GTP may return 404 or 400 for unsupported pairs — map those to 422 instead of 500.
    let entry: { buy_rate?: string; updated_at?: string; timestamp?: string } | undefined;
    try {
      const rateRes = await gtp.get(`/rates/${body.from_currency}/${body.to_currency}`);
      entry = rateRes.data.data as typeof entry;
    } catch {
      res.status(422).json({ success: false, message: `Exchange rate not available for ${body.from_currency} → ${body.to_currency}. This pair may not be supported yet.` }); return;
    }
    const rawRate = parseFloat(entry?.buy_rate ?? '0');
    if (!rawRate || isNaN(rawRate)) {
      res.status(422).json({ success: false, message: `Exchange rate not available for ${body.from_currency} → ${body.to_currency}` }); return;
    }
    const quote     = buildQuote(body.from_currency, body.to_currency, rawRate, entry?.timestamp ?? '', entry?.updated_at ?? '', 'live_market');
    const conv      = calcConversion(parseFloat(body.amount), quote);
    const reference = body.reference ?? `SWAP-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // Idempotency guard — only enforced when caller explicitly provides a reference.
    // Auto-generated references are always unique; a user-provided reference is a
    // signal that they want at-most-once semantics on that reference.
    if (body.reference) {
      const existingSwap = await findTransactionByReference(userId, body.reference, 'debit');
      if (existingSwap) {
        res.status(409).json({
          success: false,
          message: 'This swap reference has already been executed. Use a unique reference for each swap.',
          code:    'DUPLICATE_REFERENCE',
          data:    { txn_id: existingSwap.txn_id, processed_at: existingSwap.created_at },
        }); return;
      }
    }

    // 2. Debit from_currency
    try {
      await debitBalance(userId, body.from_currency, body.amount, 'swap_debit', reference,
        `Swap ${body.amount} ${body.from_currency} → ${body.to_currency}`);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        res.status(402).json({ success: false, message: err.message, data: { required: err.required, available: err.available, currency: err.currency } }); return;
      }
      throw err;
    }

    // 3. Credit to_currency — refund from_currency if this fails
    try {
      await creditBalance(userId, body.to_currency, conv.toAmount.toFixed(2), reference,
        `Swap credit ${body.from_currency} → ${body.to_currency}`);
    } catch (creditErr) {
      // Attempt to refund the debit — if THIS also fails the user has been debited
      // with no credit. Log loudly so ops can intervene manually.
      await refundBalance(userId, body.from_currency, body.amount, reference, 'Swap credit failed')
        .catch(refundErr => {
          console.error(
            `🚨 CRITICAL: swap refund failed for user=${userId} ref=${reference} ` +
            `amount=${body.amount} ${body.from_currency}. MANUAL CREDIT REQUIRED.`,
            { creditErr, refundErr },
          );
          // TODO: send ops alert email/Slack here once monitoring is wired up
        });
      throw creditErr;
    }

    auditLog('user.swap', req, { user_id: userId, from_currency: body.from_currency, to_currency: body.to_currency, from_amount: conv.fromAmount, to_amount: conv.toAmount, rate: conv.customerRate });

    // Email + SMS notification (fire-and-forget)
    getUserById(userId).then(u => {
      if (!u) return;
      sendSwapCompleted(
        u.email, u.first_name,
        body.from_currency, conv.fromAmount.toFixed(2),
        body.to_currency,   conv.toAmount.toFixed(2),
        conv.customerRate.toFixed(4),
      );
      if (u.phone) sendSwapSms(
        u.phone, u.first_name,
        body.from_currency, conv.fromAmount.toFixed(2),
        body.to_currency,   conv.toAmount.toFixed(2),
      );
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: 'Swap executed successfully',
      data: {
        settlement: {
          from_amount:   conv.fromAmount,
          from_currency: body.from_currency,
          to_amount:     conv.toAmount,
          to_currency:   body.to_currency,
          rate:          conv.customerRate,
        },
      },
    });
  } catch (err) { next(err); }
});

// ── Credit Passport ────────────────────────────────────────────────────────
//
// BVN is stored AES-256-GCM encrypted; never logged or returned to client.
// Uses the same Zeeh Africa API key as KYC.
//
const ZEEH_BASE    = 'https://api.usezeeh.com/v1';
const ZEEH_HEADERS = () => ({
  'secret-key':   process.env.ZEEH_KYC_SECRET_KEY ?? '',
  'Content-Type': 'application/json',
});

const CREDIT_REFRESH_DAYS = 30;

interface CrcFetchResult {
  report:         NigerianCreditReport;
  consumerFirst:  string;  // name from bureau — for ownership check only, never stored
  consumerLast:   string;
}

async function fetchCrcReport(bvn: string): Promise<CrcFetchResult> {
  const [scoreRes, fullRes] = await Promise.all([
    axios.post(`${ZEEH_BASE}/credit_reports/crc_score`,   { bvn, consent: true }, { headers: ZEEH_HEADERS(), timeout: 20000 }),
    axios.post(`${ZEEH_BASE}/credit_reports/crc_premium`, { bvn, consent: true }, { headers: ZEEH_HEADERS(), timeout: 20000 }),
  ]);

  const s = scoreRes.data?.data?.score ?? {};
  const f = fullRes.data?.data?.score  ?? {};

  // CRC uses several different field names across response versions — try all of them
  const consumerFirst = String(
    f.firstName ?? f.consumerFirstName ?? f.customerFirstName ??
    s.firstName ?? s.consumerFirstName ?? ''
  ).trim();
  const consumerLast = String(
    f.lastName ?? f.surname ?? f.consumerLastName ?? f.customerLastName ??
    s.lastName ?? s.surname ?? s.consumerLastName ?? ''
  ).trim();

  return {
    consumerFirst,
    consumerLast,
    report: {
      fico_score:            Number(s.ficoScore?.score   ?? 0),
      fico_rating:           String(s.ficoScore?.rating  ?? ''),
      fico_reasons:          String(s.ficoScore?.reasons ?? ''),
      total_loans:           Number(f.totalNoOfLoans             ?? s.totalNoOfLoans             ?? 0),
      active_loans:          Number(f.totalNoOfActiveLoans       ?? s.totalNoOfActiveLoans       ?? 0),
      closed_loans:          Number(f.totalNoOfClosedLoans       ?? s.totalNoOfClosedLoans       ?? 0),
      delinquent_facilities: Number(f.totalNoOfDelinquentFacilities ?? s.totalNoOfDelinquentFacilities ?? 0),
      total_borrowed:        Number(String(f.totalBorrowed    ?? 0).replace(/,/g, '')),
      total_outstanding:     Number(String(f.totalOutstanding ?? 0).replace(/,/g, '')),
      total_overdue:         Number(String(f.totalOverdue     ?? 0).replace(/,/g, '')),
      max_overdue_days:      f.maxNoOfDays ?? null,
      institutions:          Number(f.totalNoOfInstitutions ?? s.totalNoOfInstitutions ?? 0),
      credit_enquiries:      Array.isArray(f.creditEnquiries) ? f.creditEnquiries : [],
      loan_performance:      Array.isArray(f.loanPerformance) ? f.loanPerformance.map((l: Record<string, unknown>) => ({
        loanProvider:       String(l.loanProvider ?? ''),
        loanAmount:         String(l.loanAmount   ?? ''),
        status:             String(l.status       ?? ''),
        performanceStatus:  String(l.performanceStatus ?? ''),
        overdueAmount:      String(l.overdueAmount     ?? '0'),
        outstandingBalance: String(l.outstandingBalance ?? '0'),
        loanCount:          Number(l.loanCount ?? 1),
      })) : [],
      last_reported_date:  String(f.lastReportedDate ?? s.lastReportedDate ?? ''),
      report_order_number: String(f.crcReportOrderNumber ?? s.crcReportOrderNumber ?? ''),
      fetched_at:          new Date().toISOString(),
    },
  };
}

// Returns true if the bureau name plausibly matches the account holder's name.
// Only rejects when we have a bureau name AND it clearly doesn't match — if the
// bureau returns no name at all we allow through (can't verify what isn't there).
function nameMatchesAccount(
  consumerFirst: string,
  consumerLast:  string,
  accountFirst:  string,
  accountLast:   string,
): boolean {
  if (!consumerFirst && !consumerLast) return true; // bureau returned no name — can't verify

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, ' ').trim();
  const tokens = (s: string) => norm(s).split(/\s+/).filter(t => t.length > 1);

  const bureauTokens  = new Set([...tokens(consumerFirst), ...tokens(consumerLast)]);
  const accountTokens = new Set([...tokens(accountFirst),  ...tokens(accountLast)]);

  let matches = 0;
  for (const t of bureauTokens) { if (accountTokens.has(t)) matches++; }

  // Require at least 2 matching tokens, or the full bureau name is a single token
  // that appears in the account name (e.g. both parties have a single-word name)
  return matches >= 2 || (bureauTokens.size === 1 && matches === 1);
}

// POST /me/credit/setup — first-time BVN entry; fetches + stores CRC report
router.post('/credit/setup', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bvn } = req.body ?? {};
    if (!bvn || !/^\d{11}$/.test(String(bvn))) {
      res.status(400).json({ success: false, message: 'BVN must be exactly 11 digits' }); return;
    }
    if (!process.env.ZEEH_KYC_SECRET_KEY) {
      res.status(500).json({ success: false, message: 'Credit service not configured' }); return;
    }

    const userId = req.user!.user_id;
    const user   = await getUserById(userId);

    let result: CrcFetchResult;
    try {
      result = await fetchCrcReport(String(bvn));
    } catch (apiErr: unknown) {
      const status = axios.isAxiosError(apiErr) ? apiErr.response?.status : 0;
      const msg = status === 404 || status === 400
        ? 'Credit ID not found. Please check the number and try again.'
        : 'Credit bureau is temporarily unavailable. Please try again.';
      res.status(status === 404 || status === 400 ? 400 : 503).json({ success: false, message: msg }); return;
    }

    // Ownership check — bureau name must match the account holder
    if (!nameMatchesAccount(result.consumerFirst, result.consumerLast, user!.first_name, user!.last_name)) {
      auditLog('credit.setup.name_mismatch', req, {});
      res.status(422).json({
        success: false,
        message: "The details on this credit ID don't match your account. Please verify you've entered your own ID.",
      }); return;
    }

    const now      = new Date().toISOString();
    const existing = await getCreditRecord(userId);

    const record: CreditRecord = {
      user_id:           userId,
      bvn_encrypted:     encryptBvn(String(bvn)),
      nigerian_report:   result.report,
      canadian_report:   null,
      created_at:        existing?.created_at ?? now,
      updated_at:        now,
      last_refreshed_at: now,
    };
    await saveCreditRecord(record);

    auditLog('credit.setup', req, { fico_score: result.report.fico_score });

    res.json({ success: true, data: { nigerian_report: result.report, canadian_report: null } });
  } catch (err) { next(err); }
});

// GET /me/credit — return cached credit report
router.get('/credit', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const record = await getCreditRecord(req.user!.user_id);
    if (!record) {
      res.json({ success: true, data: null }); return;
    }

    // Compute when the next refresh is available so the client can display it
    const nextRefreshAt = record.last_refreshed_at
      ? new Date(new Date(record.last_refreshed_at).getTime() + CREDIT_REFRESH_DAYS * 86400_000).toISOString()
      : null;

    res.json({
      success: true,
      data: {
        nigerian_report:  record.nigerian_report,
        canadian_report:  record.canadian_report,
        updated_at:       record.updated_at,
        next_refresh_at:  nextRefreshAt,
      },
    });
  } catch (err) { next(err); }
});

// POST /me/credit/refresh — re-fetch report using stored encrypted ID
router.post('/credit/refresh', requireEmailVerified, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.user_id;
    const record = await getCreditRecord(userId);
    if (!record?.bvn_encrypted) {
      res.status(404).json({ success: false, message: 'No credit profile set up yet.' }); return;
    }

    // Rate limit — one refresh per CREDIT_REFRESH_DAYS days
    if (record.last_refreshed_at) {
      const nextRefresh = new Date(new Date(record.last_refreshed_at).getTime() + CREDIT_REFRESH_DAYS * 86400_000);
      if (new Date() < nextRefresh) {
        const nextStr = nextRefresh.toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric' });
        res.status(429).json({
          success: false,
          message: `You can refresh your credit report once per ${CREDIT_REFRESH_DAYS} days. Next refresh available on ${nextStr}.`,
          next_refresh_at: nextRefresh.toISOString(),
        }); return;
      }
    }

    const bvn = decryptBvn(record.bvn_encrypted);
    let result: CrcFetchResult;
    try {
      result = await fetchCrcReport(bvn);
    } catch (apiErr: unknown) {
      const status = axios.isAxiosError(apiErr) ? apiErr.response?.status : 0;
      res.status(status === 404 || status === 400 ? 400 : 503).json({
        success: false, message: 'Credit bureau temporarily unavailable. Please try again.',
      }); return;
    }

    const now = new Date().toISOString();
    await saveCreditRecord({ ...record, nigerian_report: result.report, updated_at: now, last_refreshed_at: now });
    auditLog('credit.refresh', req, { fico_score: result.report.fico_score });

    const nextRefreshAt = new Date(new Date(now).getTime() + CREDIT_REFRESH_DAYS * 86400_000).toISOString();
    res.json({ success: true, data: { nigerian_report: result.report, canadian_report: null, updated_at: now, next_refresh_at: nextRefreshAt } });
  } catch (err) { next(err); }
});

export default router;
