import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { gtp } from '../lib/gtpClient';
import { flw, FLW_CURRENCIES, FLW_MOBILE_MONEY, FLW_DEFAULT_NETWORK, FLW_COUNTRY, FLW_SOURCE_CURRENCY } from '../lib/flutterwaveClient';
import { auditLog } from '../middleware/logger';
import { debitBalance, refundBalance, findTransactionByReference, InsufficientBalanceError } from '../lib/ledger';
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
  // GBP (Faster Payments)
  sort_code:     z.string().regex(/^\d{2}-?\d{2}-?\d{2}$/).optional(), // 6-digit, e.g. 20-00-00
  // EUR (SEPA)
  iban:          z.string().max(34).optional(),
  bic:           z.string().max(11).optional(),
  // Flutterwave — all African currencies (bank + mobile money)
  account_bank:         z.string().max(50).optional(),   // FLW bank code (e.g. "044" for Access Bank GH)
  recipient_first_name: z.string().max(100).optional(),
  recipient_last_name:  z.string().max(100).optional(),
  msisdn:               z.string().max(20).optional(),   // phone with country code e.g. 254712345678
  mobile_network:       z.string().max(50).optional(),   // override default network (e.g. "Airtel")
  // ZAR compliance fields (required by Flutterwave for South Africa)
  recipient_phone:   z.string().max(20).optional(),
  recipient_address: z.string().max(255).optional(),
  recipient_city:    z.string().max(100).optional(),
  recipient_country: z.string().length(2).optional(),    // ISO-3166 alpha-2
  recipient_postal_code: z.string().max(20).optional(),
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

    // Idempotency — if this client_reference was already processed, return the original result
    const existing = await findTransactionByReference(clientId, client_reference, 'debit');
    if (existing) {
      res.status(200).json({
        success: true,
        message: 'Duplicate request — this client_reference was already processed.',
        data: { idempotent: true, original_txn_id: existing.txn_id, created_at: existing.created_at },
      });
      return;
    }

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

    // ── 2. Execute with provider — refund immediately if it fails ─────────
    let responseData: unknown;

    if (FLW_CURRENCIES.has(currency)) {
      // ── Flutterwave path ────────────────────────────────────────────────
      const isMobileMoney = FLW_MOBILE_MONEY.has(currency);
      const traceId = String(req.headers['x-request-id'] ?? `zeeh-${Date.now()}`).padEnd(12, '0').slice(0, 255);

      const flwPayload = {
        reference: client_reference,
        narration:  parsed.data.description ?? `Payout ${amount} ${currency}`,
        instruction: {
          destination_currency: currency,
          source_currency:      FLW_SOURCE_CURRENCY,
          amount: {
            value:      parseFloat(amount),
            applies_to: 'destination_currency',
          },
          recipient: isMobileMoney
            ? {
                type: 'mobile_money',
                name: {
                  first: parsed.data.recipient_first_name ?? 'Recipient',
                  last:  parsed.data.recipient_last_name  ?? 'Name',
                },
                mobile_money: {
                  network: parsed.data.mobile_network ?? FLW_DEFAULT_NETWORK[currency] ?? '',
                  country: FLW_COUNTRY[currency] ?? '',
                  msisdn:  parsed.data.msisdn ?? '',
                },
              }
            : {
                type: 'bank',
                name: {
                  first: parsed.data.recipient_first_name ?? 'Recipient',
                  last:  parsed.data.recipient_last_name  ?? 'Name',
                },
                bank: {
                  account_number: parsed.data.account_number ?? '',
                  code:           parsed.data.account_bank   ?? '',
                },
                // ZAR (South Africa) requires additional compliance fields
                ...(currency === 'ZAR' ? {
                  email: parsed.data.recipient_email,
                  phone: parsed.data.recipient_phone
                    ? { country_code: '27', number: parsed.data.recipient_phone }
                    : undefined,
                  address: parsed.data.recipient_address ? {
                    line1:       parsed.data.recipient_address,
                    city:        parsed.data.recipient_city    ?? '',
                    country:     parsed.data.recipient_country ?? 'ZA',
                    postal_code: parsed.data.recipient_postal_code ?? '',
                  } : undefined,
                } : {}),
              },
          sender: {
            name: {
              first: process.env.FLW_SENDER_NAME_FIRST ?? 'Zeeh',
              last:  process.env.FLW_SENDER_NAME_LAST  ?? 'Finance',
            },
          },
        },
      };

      try {
        const { data } = await flw.post('/direct-transfers', flwPayload, {
          headers: {
            'X-Trace-Id':        traceId,
            'X-Idempotency-Key': client_reference,
          },
        });
        responseData = data;
      } catch (flwErr) {
        await refundBalance(clientId, currency, amount, client_reference, 'Flutterwave transfer failed').catch(() => {});
        throw flwErr;
      }

      auditLog('transfer.initiated', req, {
        client_id:   clientId,
        client_name: req.apiClient!.client_name,
        provider:    'flutterwave',
        amount, currency, client_reference,
        transfer_id: ((responseData as Record<string, unknown>)?.id as string | undefined),
      });

    } else {
      // ── Expedier / GTP path ─────────────────────────────────────────────
      try {
        const { data } = await gtp.post('/transfers', parsed.data);
        responseData = data;
      } catch (gtpErr) {
        await refundBalance(clientId, currency, amount, client_reference, 'GTP transfer failed').catch(() => {});
        throw gtpErr;
      }

      auditLog('transfer.initiated', req, {
        client_id:   clientId,
        client_name: req.apiClient!.client_name,
        provider:    'expedier',
        amount, currency, client_reference,
        transfer_id: ((responseData as Record<string, unknown> & { data?: Record<string, unknown> })?.data?.transfer as Record<string, unknown> | undefined)?.transfer_id as string | undefined,
      });
    }

    res.status(201).json(responseData);
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
