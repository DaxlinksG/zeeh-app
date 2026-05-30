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
  first_name: z.string().min(1).max(60).optional(),
  last_name:  z.string().min(1).max(60).optional(),
  phone:      z.string().min(7).max(20).optional(),
  country:    z.string().min(2).max(60).optional(),
});

router.put('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }

    // SECURITY: Block name changes once KYC has been initiated.
    // If allowed, a user could change their name to match a stolen identity,
    // re-submit KYC, and pass verification as someone else.
    const kycActive = ['pending', 'approved'].includes(req.user!.kyc_status);
    if (kycActive && (parsed.data.first_name || parsed.data.last_name)) {
      res.status(400).json({
        success: false,
        message: 'Name cannot be changed after KYC verification has been submitted. Contact support if your name is incorrect.',
        code: 'NAME_LOCKED_POST_KYC',
      }); return;
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
    if (req.user!.kyc_status === 'approved') {
      res.status(400).json({ success: false, message: 'KYC already approved' }); return;
    }

    const kycApiKey = process.env.KYC_API_KEY;
    const kycBase   = process.env.KYC_SERVICE_URL ?? 'https://kyc.zeehfi.ca';
    if (!kycApiKey) {
      res.status(500).json({ success: false, message: 'KYC service not configured' }); return;
    }

    const u = await getUserById(req.user!.user_id);
    if (!u) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    // Pass the user's ID as externalId so the webhook can resolve it back to this user.
    const { data: session } = await axios.post(
      `${kycBase}/v1/sessions`,
      {
        externalId: u.user_id,
        metadata:   { email: u.email, first_name: u.first_name, last_name: u.last_name },
      },
      {
        headers: { Authorization: `Bearer ${kycApiKey}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      },
    );

    auditLog('kyc.session_started', req, { session_id: session.session_id });

    res.json({
      success: true,
      data: {
        session_id: session.session_id,
        widget_url: session.widget_url,
        expires_at: session.expires_at,
      },
    });
  } catch (err) { next(err); }
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

export default router;
