import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { gtp } from '../lib/gtpClient';
import { buildQuote, calcConversion } from '../lib/spreadEngine';
import { auditLog } from '../middleware/logger';

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

    // 1. Fetch current rate
    const rateRes = await gtp.get(`/rates/${body.from_currency}/${body.to_currency}`);
    const entry = rateRes.data.data as {
      buy_rate: string;
      updated_at: string;
      timestamp: string;
    };

    const rawRate = parseFloat(entry.buy_rate);
    const fromAmount = parseFloat(body.amount);
    const quote = buildQuote(body.from_currency, body.to_currency, rawRate, entry.timestamp, entry.updated_at, 'live_market');
    const conversion = calcConversion(fromAmount, quote);

    // 2. Execute the swap with GTP at the full raw amount (we swap the real amount, customer receives less)
    // The from_amount is what we debit; GTP swaps at their rate giving us raw_to_amount.
    // We credit the customer customer_to_amount and retain spread_revenue internally.
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
          from_amount: conversion.fromAmount,
          from_currency: body.from_currency,
          to_amount: conversion.toAmount,
          to_currency: body.to_currency,
          customer_rate: conversion.customerRate,
          spread_pct: conversion.spreadPct,
          spread_revenue: conversion.spreadRevenue,
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
