import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { gtp } from '../lib/gtpClient';
import { auditLog } from '../middleware/logger';
import { debitBalance, refundBalance, InsufficientBalanceError } from '../lib/ledger';
import { assertNotFrozen, FrozenCurrencyError } from '../lib/circuitBreaker';

const router = Router();

const transferSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  currency: z.string().length(3).toUpperCase(),
  client_reference: z.string().min(1).max(100),
  reference: z.string().max(255).optional(),
  description: z.string().max(255).optional(),
  // NGN
  bank_id: z.number().int().optional(),
  account_number: z.string().optional(),
  account_name: z.string().optional(),
  // CAD
  recipient_email: z.string().email().optional(),
  // USD
  bank_name: z.string().optional(),
  routing_number: z.string().optional(),
  email: z.string().email().optional(),
  account_type: z.enum(['checking', 'savings']).optional(),
  address: z.string().optional(),
  state_id: z.number().int().optional(),
  city: z.string().optional(),
  postal_code: z.string().optional(),
  // GBP/EUR
  // Internal
  recipient_uid: z.string().optional(),
});

// POST /api/transfers
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Validation error', errors: parsed.error.flatten() });
      return;
    }

    const clientId = req.apiClient!.key_id;
    const { amount, currency, client_reference } = parsed.data;

    // Circuit breaker — block if this currency's outflows are frozen
    try { await assertNotFrozen(currency); } catch (e) {
      if (e instanceof FrozenCurrencyError)
        return void res.status(503).json({ success: false, message: `${currency} transfers are temporarily suspended. Please try again later.`, code: 'CURRENCY_FROZEN' });
      throw e;
    }

    // ── 1. Debit ledger atomically before touching GTP ─────────────────────
    try {
      await debitBalance(
        clientId, currency, amount, 'transfer',
        client_reference,
        parsed.data.description ?? `Transfer ${amount} ${currency}`,
        { currency, amount },
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

    // ── 2. Execute with GTP — refund immediately if it fails ───────────────
    let gtpData;
    try {
      const { data } = await gtp.post('/transfers', parsed.data);
      gtpData = data;
    } catch (gtpErr) {
      await refundBalance(clientId, currency, amount, client_reference, 'GTP transfer failed').catch(() => {});
      throw gtpErr;
    }

    auditLog('transfer.initiated', req, {
      client_id: clientId, client_name: req.apiClient!.client_name,
      amount, currency, client_reference,
      transfer_id: (gtpData.data?.transfer as Record<string, unknown>)?.transfer_id,
    });

    res.status(201).json(gtpData);
  } catch (err) {
    next(err);
  }
});

// GET /api/transfers/list
router.get('/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/transfers/list', { params: req.query });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/transfers/verification?reference=
router.get('/verification', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/transfers/verification', { params: req.query });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/transfers/:transfer_id
router.get('/:transfer_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get(`/transfers/${req.params.transfer_id}`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
