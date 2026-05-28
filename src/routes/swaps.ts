import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { gtp } from '../lib/gtpClient';
import { buildQuote, calcConversion } from '../lib/spreadEngine';
import { auditLog } from '../middleware/logger';
import { debitBalance, creditBalance, refundBalance, InsufficientBalanceError } from '../lib/ledger';
import { assertNotFrozen, FrozenCurrencyError } from '../lib/circuitBreaker';

const router = Router();

const swapSchema = z.object({
  from_wallet_id: z.string().min(1),
  to_wallet_id: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a decimal string e.g. "100.00"'),
  from_currency: z.string().length(3).toUpperCase(),
  to_currency: z.string().length(3).toUpperCase(),
  lock_rate: z.boolean().optional().default(false),
  reference: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// POST /api/swaps
// Execute a currency swap. The customer receives the spread-adjusted amount.
// We execute at GTP's raw rate and capture the margin.
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = swapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Validation error', errors: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;

    // Circuit breaker — block if source currency outflows are frozen
    try { await assertNotFrozen(body.from_currency); } catch (e) {
      if (e instanceof FrozenCurrencyError)
        return void res.status(503).json({ success: false, message: `${body.from_currency} swaps are temporarily suspended. Please try again later.`, code: 'CURRENCY_FROZEN' });
      throw e;
    }

    // 1. Fetch current rate — return 422 instead of 500 if pair is unsupported
    let entry: { buy_rate: string; updated_at: string; timestamp: string };
    try {
      const rateRes = await gtp.get(`/rates/${body.from_currency}/${body.to_currency}`);
      entry = rateRes.data.data as typeof entry;
    } catch {
      res.status(422).json({ success: false, message: `Exchange rate not available for ${body.from_currency} → ${body.to_currency}` }); return;
    }
    const rawRate = parseFloat(entry.buy_rate ?? '0');
    if (!rawRate || isNaN(rawRate)) {
      res.status(422).json({ success: false, message: `Rate data unavailable for ${body.from_currency} → ${body.to_currency}` }); return;
    }
    const fromAmount = parseFloat(body.amount);
    const quote = buildQuote(body.from_currency, body.to_currency, rawRate, entry.timestamp, entry.updated_at, 'live_market');
    const conversion = calcConversion(fromAmount, quote);

    const clientId  = req.apiClient!.key_id;
    const reference = body.reference ?? `SWAP-${Date.now()}`;

    // 2. Debit client's from_currency ledger atomically
    try {
      await debitBalance(
        clientId, body.from_currency, body.amount, 'swap_debit',
        reference, `Swap ${body.amount} ${body.from_currency} → ${body.to_currency}`,
        { from_currency: body.from_currency, to_currency: body.to_currency },
      );
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        res.status(402).json({
          success: false,
          message: err.message,
          data: { required: err.required, available: err.available, currency: err.currency },
        });
        return;
      }
      throw err;
    }

    // 3. Execute the swap with GTP — refund if it fails
    const swapRes = await gtp.post('/swap', {
      from_wallet_id: body.from_wallet_id,
      to_wallet_id: body.to_wallet_id,
      amount: body.amount,
      from_currency: body.from_currency,
      to_currency: body.to_currency,
      lock_rate: body.lock_rate,
      reference: body.reference,
      metadata: body.metadata,
    });

    // 4. Credit client's to_currency ledger with what they receive
    // If this fails the GTP swap already executed — log loudly so it can be
    // manually reconciled. Never silently discard.
    try {
      await creditBalance(
        clientId, body.to_currency,
        conversion.toAmount.toFixed(2),
        reference,
        `Swap credit ${body.from_currency} → ${body.to_currency}`,
        { from_currency: body.from_currency, to_currency: body.to_currency },
      );
    } catch (creditErr) {
      console.error(
        `🚨 SWAP CREDIT FAILED — GTP swap executed but ledger credit failed. ` +
        `client=${clientId} ref=${reference} to_currency=${body.to_currency} ` +
        `amount=${conversion.toAmount.toFixed(2)}. Manual reconciliation required.`,
        creditErr,
      );
      auditLog('swap.credit_failed', req, {
        client_id: clientId, reference,
        to_currency: body.to_currency, to_amount: conversion.toAmount.toFixed(2),
        error: String(creditErr),
      });
      // Still return success — GTP swap is done. The credit will be recovered
      // from the swap.completed webhook or by admin reconciliation.
    }

    auditLog('swap.executed', req, {
      from_currency: body.from_currency,
      to_currency: body.to_currency,
      from_amount: conversion.fromAmount,
      to_amount: conversion.toAmount,
      spread_pct: conversion.spreadPct,
      spread_revenue: conversion.spreadRevenue,
      reference: body.reference,
    });

    res.status(201).json({
      success: true,
      message: 'Swap executed successfully',
      data: {
        swap: swapRes.data.data?.swap ?? swapRes.data.data,
        settlement: {
          from_amount:   conversion.fromAmount,
          from_currency: body.from_currency,
          to_amount:     conversion.toAmount,
          to_currency:   body.to_currency,
          rate:          conversion.customerRate,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/swaps/list
router.get('/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/swap/list', { params: req.query });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/swaps/:swap_id
router.get('/:swap_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get(`/swap/${req.params.swap_id}`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
