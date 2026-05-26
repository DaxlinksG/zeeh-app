import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { gtp } from '../lib/gtpClient';
import { buildQuote, calcConversion } from '../lib/spreadEngine';

const router = Router();

// GET /api/rates
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/rates');
    const gtpData = data.data as {
      rates: { from_currency: string; to_currency: string; buy_rate: string; updated_at: string }[];
      count: number;
      timestamp: string;
    };

    const rates = gtpData.rates
      .filter((e) => e.from_currency !== e.to_currency)
      .map((entry) => {
        const rawRate = parseFloat(entry.buy_rate);
        const quote = buildQuote(entry.from_currency, entry.to_currency, rawRate, entry.updated_at, entry.updated_at, 'live_market');
        return {
          from_currency: entry.from_currency,
          to_currency:   entry.to_currency,
          rate:          quote.customerRate,
          inverse_rate:  quote.inverseCustomerRate,
          updated_at:    entry.updated_at,
        };
      });

    res.json({
      success: true,
      data: { rates, count: rates.length, timestamp: gtpData.timestamp },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/rates/convert?amount=&from_currency=&to_currency=
const convertSchema = z.object({
  amount:        z.coerce.number().positive(),
  from_currency: z.string().min(3).max(3).toUpperCase(),
  to_currency:   z.string().min(3).max(3).toUpperCase(),
});

router.get('/convert', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = convertSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Validation error', errors: parsed.error.flatten() });
      return;
    }
    const { amount, from_currency, to_currency } = parsed.data;

    const { data } = await gtp.get(`/rates/${from_currency}/${to_currency}`);
    const entry = data.data as {
      from_currency: string; to_currency: string;
      buy_rate: string; updated_at: string; timestamp: string;
    };

    const rawRate    = parseFloat(entry.buy_rate);
    const quote      = buildQuote(from_currency, to_currency, rawRate, entry.timestamp, entry.updated_at, 'live_market');
    const conversion = calcConversion(amount, quote);

    res.json({
      success: true,
      data: {
        from_currency,
        to_currency,
        from_amount: conversion.fromAmount,
        to_amount:   conversion.toAmount,
        rate:        conversion.customerRate,
        updated_at:  entry.updated_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/rates/:from_currency/:to_currency
router.get('/:from_currency/:to_currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from_currency, to_currency } = req.params;
    const { data } = await gtp.get(`/rates/${from_currency.toUpperCase()}/${to_currency.toUpperCase()}`);
    const entry = data.data as {
      from_currency: string; to_currency: string;
      buy_rate: string; updated_at: string; timestamp: string;
    };

    const rawRate = parseFloat(entry.buy_rate);
    const quote   = buildQuote(from_currency, to_currency, rawRate, entry.timestamp, entry.updated_at, 'live_market');

    res.json({
      success: true,
      data: {
        from_currency: quote.fromCurrency,
        to_currency:   quote.toCurrency,
        rate:          quote.customerRate,
        inverse_rate:  quote.inverseCustomerRate,
        updated_at:    entry.updated_at,
        timestamp:     entry.timestamp,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
