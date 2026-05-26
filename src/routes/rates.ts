import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { gtp } from '../lib/gtpClient';
import { buildQuote, calcConversion } from '../lib/spreadEngine';
import { corridorSpreads, getSpreadPct } from '../config/spread';

const router = Router();

// GET /api/rates
// Returns all available rates with spread applied
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/rates');
    const gtpData = data.data as {
      rates: { from_currency: string; to_currency: string; buy_rate: string; updated_at: string }[];
      count: number;
      timestamp: string;
    };

    const spreadRates = gtpData.rates
      .filter((e) => e.from_currency !== e.to_currency) // skip same-currency pairs
      .map((entry) => {
        const rawRate = parseFloat(entry.buy_rate);
        const quote = buildQuote(entry.from_currency, entry.to_currency, rawRate, entry.updated_at, entry.updated_at, 'live_market');
        return {
          from_currency: entry.from_currency,
          to_currency: entry.to_currency,
          customer_rate: quote.customerRate,
          inverse_customer_rate: quote.inverseCustomerRate,
          spread_pct: quote.spreadPct,
          updated_at: entry.updated_at,
        };
      });

    res.json({
      success: true,
      message: 'Exchange rates retrieved successfully',
      data: {
        rates: spreadRates,
        count: spreadRates.length,
        timestamp: gtpData.timestamp,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/rates/spreads
// Returns current spread configuration (admin/transparency endpoint)
router.get('/spreads', (_req: Request, res: Response) => {
  const defaultSpread = parseFloat(process.env.DEFAULT_SPREAD_PCT ?? '2.0');
  res.json({
    success: true,
    message: 'Spread configuration retrieved',
    data: {
      corridors: corridorSpreads,
      default_spread_pct: defaultSpread,
    },
  });
});

// GET /api/rates/convert?amount=&from_currency=&to_currency=
// Calculates a conversion with spread applied
const convertSchema = z.object({
  amount: z.coerce.number().positive(),
  from_currency: z.string().min(3).max(3).toUpperCase(),
  to_currency: z.string().min(3).max(3).toUpperCase(),
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
      from_currency: string;
      to_currency: string;
      buy_rate: string;
      updated_at: string;
      timestamp: string;
    };

    const rawRate = parseFloat(entry.buy_rate);
    const quote = buildQuote(from_currency, to_currency, rawRate, entry.timestamp, entry.updated_at, 'live_market');
    const conversion = calcConversion(amount, quote);

    res.json({
      success: true,
      message: 'Conversion calculated successfully',
      data: {
        from_currency,
        to_currency,
        from_amount: conversion.fromAmount,
        to_amount: conversion.toAmount,
        customer_rate: conversion.customerRate,
        spread_pct: conversion.spreadPct,
        spread_revenue: conversion.spreadRevenue,
        updated_at: entry.updated_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/rates/:from_currency/:to_currency
// Returns a single spread-adjusted rate
router.get('/:from_currency/:to_currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from_currency, to_currency } = req.params;
    const { data } = await gtp.get(`/rates/${from_currency.toUpperCase()}/${to_currency.toUpperCase()}`);
    const entry = data.data as {
      from_currency: string;
      to_currency: string;
      buy_rate: string;
      updated_at: string;
      timestamp: string;
    };

    const rawRate = parseFloat(entry.buy_rate);
    const spreadPct = getSpreadPct(from_currency, to_currency);
    const quote = buildQuote(from_currency, to_currency, rawRate, entry.timestamp, entry.updated_at, 'live_market');

    res.json({
      success: true,
      message: 'Exchange rate retrieved successfully',
      data: {
        from_currency: quote.fromCurrency,
        to_currency: quote.toCurrency,
        customer_rate: quote.customerRate,
        inverse_customer_rate: quote.inverseCustomerRate,
        spread_pct: spreadPct,
        updated_at: entry.updated_at,
        timestamp: entry.timestamp,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
