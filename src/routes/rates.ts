import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { gtp } from '../lib/gtpClient';
import { buildQuote, calcConversion } from '../lib/spreadEngine';
import { isFrozen } from '../lib/circuitBreaker';

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

// GET /api/rates/status — list all circuit breaker states (useful for client dashboards)
router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { listFrozen } = await import('../lib/circuitBreaker');
    const frozen = await listFrozen();
    const frozenSet = new Set(frozen.map(f => f.currency));
    res.json({
      success: true,
      data: {
        frozen_currencies: frozen.map(f => ({
          currency:  f.currency,
          reason:    f.reason,
          frozen_at: f.frozen_at,
          frozen_by: f.frozen_by,
        })),
        note: 'Frozen currencies will return 503 on swap/transfer requests until resolved.',
      },
    });
    void frozenSet; // suppress unused warning
  } catch (err) { next(err); }
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

    let entry: { from_currency: string; to_currency: string; buy_rate: string; updated_at: string; timestamp: string };
    try {
      const { data } = await gtp.get(`/rates/${from_currency}/${to_currency}`);
      entry = data.data as typeof entry;
    } catch {
      res.status(422).json({ success: false, message: `Rate not available for ${from_currency}/${to_currency}` }); return;
    }

    const rawRate    = parseFloat(entry.buy_rate ?? '0');
    if (!rawRate || isNaN(rawRate)) {
      res.status(422).json({ success: false, message: `Rate data missing for ${from_currency}/${to_currency}` }); return;
    }
    const quote      = buildQuote(from_currency, to_currency, rawRate, entry.timestamp, entry.updated_at, 'live_market');
    const conversion = calcConversion(amount, quote);

    // Include circuit breaker status in the response so clients know before submitting
    const frozen = await isFrozen(from_currency);

    res.json({
      success: true,
      data: {
        from_currency,
        to_currency,
        from_amount:    conversion.fromAmount,
        to_amount:      conversion.toAmount,
        rate:           conversion.customerRate,
        updated_at:     entry.updated_at,
        ...(frozen ? { warning: `${from_currency} outflows are currently suspended. Swap requests will be rejected.` } : {}),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/rates/:from_currency/:to_currency
router.get('/:from_currency/:to_currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const from = req.params.from_currency.toUpperCase();
    const to   = req.params.to_currency.toUpperCase();

    let entry: { from_currency: string; to_currency: string; buy_rate: string; updated_at: string; timestamp: string };
    try {
      const { data } = await gtp.get(`/rates/${from}/${to}`);
      entry = data.data as typeof entry;
    } catch {
      res.status(422).json({ success: false, message: `Rate not available for ${from}/${to}. Pair may not be supported by Expedier.` }); return;
    }

    const rawRate = parseFloat(entry.buy_rate ?? '0');
    if (!rawRate || isNaN(rawRate)) {
      res.status(422).json({ success: false, message: `Rate data missing for ${from}/${to}` }); return;
    }
    const quote = buildQuote(from, to, rawRate, entry.timestamp, entry.updated_at, 'live_market');
    const frozen = await isFrozen(from);

    res.json({
      success: true,
      data: {
        from_currency: quote.fromCurrency,
        to_currency:   quote.toCurrency,
        rate:          quote.customerRate,
        inverse_rate:  quote.inverseCustomerRate,
        updated_at:    entry.updated_at,
        timestamp:     entry.timestamp,
        ...(frozen ? { warning: `${from} outflows are currently suspended.` } : {}),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
