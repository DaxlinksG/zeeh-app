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
import {
  getUserById, getUserByEmail,
  updateUserProfile, submitKyc, getKyc,
} from '../lib/userStore';
import {
  getBalance, getAllBalances, getTransactions,
  debitBalance, creditBalance, refundBalance,
  InsufficientBalanceError,
} from '../lib/ledger';
import { gtp } from '../lib/gtpClient';
import { buildQuote, calcConversion } from '../lib/spreadEngine';
import { listDepositInstructions } from '../lib/depositConfig';
import { requireKyc } from '../middleware/userAuth';
import { auditLog } from '../middleware/logger';
import {
  sendKycSubmitted, sendAdminKycAlert,
  sendMoneySent, sendMoneyReceived,
  sendSwapCompleted,
  sendTransferInitiated,
} from '../lib/mailer';
import { assertNotFrozen, FrozenCurrencyError } from '../lib/circuitBreaker';

const router = Router();

// ── Profile ────────────────────────────────────────────────────────────────
router.get('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getUserById(req.user!.user_id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found' }); return; }

    const kyc = await getKyc(user.user_id);
    res.json({
      success: true,
      data: {
        user_id:    user.user_id,
        email:      user.email,
        first_name: user.first_name,
        last_name:  user.last_name,
        phone:      user.phone,
        country:    user.country,
        kyc_status: user.kyc_status,
        created_at: user.created_at,
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
    await updateUserProfile(req.user!.user_id, parsed.data);
    res.json({ success: true, message: 'Profile updated' });
  } catch (err) { next(err); }
});

// ── KYC ────────────────────────────────────────────────────────────────────
const kycSchema = z.object({
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD format'),
  nationality:   z.string().min(2).max(60),
  address: z.object({
    street:      z.string().min(2),
    city:        z.string().min(2),
    state:       z.string().min(2),
    country:     z.string().min(2),
    postal_code: z.string().min(2),
  }),
  id_type:   z.enum(['passport', 'drivers_license', 'national_id']),
  id_number: z.string().min(3).max(50),
});

router.post('/kyc', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.kyc_status === 'approved') {
      res.status(400).json({ success: false, message: 'KYC already approved' }); return;
    }
    const parsed = kycSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }
    const record = await submitKyc(req.user!.user_id, parsed.data);

    // Notify user + admin (fire-and-forget)
    const u = await getUserById(req.user!.user_id).catch(() => null);
    if (u) {
      sendKycSubmitted(u.email, u.first_name);
      sendAdminKycAlert(u.email, u.user_id, `${u.first_name} ${u.last_name}`);
    }

    res.status(201).json({ success: true, message: 'KYC submitted — we will review within 24 hours', data: { submitted_at: record.submitted_at } });
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

// ── P2P Send ───────────────────────────────────────────────────────────────
const sendSchema = z.object({
  recipient_email: z.string().email(),
  currency:        z.string().length(3).toUpperCase(),
  amount:          z.string().regex(/^\d+(\.\d{1,2})?$/),
  note:            z.string().max(255).optional(),
});

router.post('/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }
    const { recipient_email, currency, amount, note } = parsed.data;
    const senderId = req.user!.user_id;

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

    // Email notifications (fire-and-forget)
    const senderUser = await getUserById(senderId).catch(() => null);
    const senderName = senderUser ? `${senderUser.first_name} ${senderUser.last_name}` : req.user!.email;
    sendMoneySent(req.user!.email, senderUser?.first_name ?? '', recipient.email, currency, amount, reference);
    sendMoneyReceived(recipient.email, recipient.first_name, senderName, currency, amount);

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

router.post('/transfer', requireKyc, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }
    const { amount, currency, client_reference } = parsed.data;
    const userId = req.user!.user_id;

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

    // Forward to GTP with Zeeh's B2B API key
    let gtpData;
    try {
      const { data } = await gtp.post('/transfers', parsed.data);
      gtpData = data;
    } catch (gtpErr) {
      await refundBalance(userId, currency, amount, client_reference, 'GTP transfer failed').catch(() => {});
      throw gtpErr;
    }

    auditLog('user.transfer', req, { user_id: userId, amount, currency, client_reference });

    // Email notification (fire-and-forget)
    getUserById(userId).then(u => {
      if (u) sendTransferInitiated(u.email, u.first_name, currency, amount, client_reference);
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

router.post('/swap', requireKyc, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = swapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }
    const body   = parsed.data;
    const userId = req.user!.user_id;

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
    const reference = body.reference ?? `SWAP-${Date.now()}`;

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
    } catch (err) {
      await refundBalance(userId, body.from_currency, body.amount, reference, 'Swap credit failed').catch(() => {});
      throw err;
    }

    auditLog('user.swap', req, { user_id: userId, from_currency: body.from_currency, to_currency: body.to_currency, from_amount: conv.fromAmount, to_amount: conv.toAmount, rate: conv.customerRate });

    // Email notification (fire-and-forget)
    getUserById(userId).then(u => {
      if (u) sendSwapCompleted(
        u.email, u.first_name,
        body.from_currency, conv.fromAmount.toFixed(2),
        body.to_currency,   conv.toAmount.toFixed(2),
        conv.customerRate.toFixed(4),
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
