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
import { requireKyc } from '../middleware/userAuth';
import { auditLog } from '../middleware/logger';

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
router.get('/deposit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Re-use the wallets GTP endpoint to get virtual account details
    const { data } = await gtp.get('/wallets');
    const wallets = (data.data?.wallets ?? data.data ?? []) as Record<string, unknown>[];

    const instructions: Record<string, unknown>[] = wallets.map((w: Record<string, unknown>) => {
      const currency = String(w.currency ?? '').toUpperCase();
      const details  = w.user_bank_details as Record<string, unknown> | undefined ?? {};
      return { currency, ...details, wallet_id: w.wallet_id ?? w.id };
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
    const rateRes = await gtp.get(`/rates/${from}/${to}`);
    const entry   = rateRes.data.data as { buy_rate: string; updated_at: string; timestamp: string };
    const rawRate = parseFloat(entry.buy_rate);
    const quote   = buildQuote(from, to, rawRate, entry.timestamp, entry.updated_at, 'live_market');
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
    res.status(201).json(gtpData);
  } catch (err) { next(err); }
});

// ── Swap — KYC required ────────────────────────────────────────────────────
const swapSchema = z.object({
  from_wallet_id: z.string().min(1),
  to_wallet_id:   z.string().min(1),
  amount:         z.string().regex(/^\d+(\.\d{1,2})?$/),
  from_currency:  z.string().length(3).toUpperCase(),
  to_currency:    z.string().length(3).toUpperCase(),
  lock_rate:      z.boolean().optional().default(false),
  reference:      z.string().max(100).optional(),
});

router.post('/swap', requireKyc, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = swapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }
    const body   = parsed.data;
    const userId = req.user!.user_id;

    // Get live rate
    const rateRes  = await gtp.get(`/rates/${body.from_currency}/${body.to_currency}`);
    const entry    = rateRes.data.data as { buy_rate: string; updated_at: string; timestamp: string };
    const rawRate  = parseFloat(entry.buy_rate);
    const quote    = buildQuote(body.from_currency, body.to_currency, rawRate, entry.timestamp, entry.updated_at, 'live_market');
    const conv     = calcConversion(parseFloat(body.amount), quote);
    const reference = body.reference ?? `SWAP-${Date.now()}`;

    // Debit from_currency
    try {
      await debitBalance(userId, body.from_currency, body.amount, 'swap_debit', reference, `Swap ${body.amount} ${body.from_currency} → ${body.to_currency}`);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        res.status(402).json({ success: false, message: err.message, data: { required: err.required, available: err.available, currency: err.currency } }); return;
      }
      throw err;
    }

    // Execute swap with GTP
    const swapRes = await gtp.post('/swap', {
      from_wallet_id: body.from_wallet_id, to_wallet_id: body.to_wallet_id,
      amount: body.amount, from_currency: body.from_currency,
      to_currency: body.to_currency, lock_rate: body.lock_rate,
    });

    // Credit to_currency
    await creditBalance(userId, body.to_currency, conv.toAmount.toFixed(2), reference, `Swap credit ${body.from_currency} → ${body.to_currency}`)
      .catch(() => {/* reconcile via webhook */});

    auditLog('user.swap', req, { user_id: userId, from_currency: body.from_currency, to_currency: body.to_currency, from_amount: conv.fromAmount, to_amount: conv.toAmount });

    res.status(201).json({
      success: true,
      message: 'Swap executed successfully',
      data: {
        swap: swapRes.data.data?.swap ?? swapRes.data.data,
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
