import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  createVirtualAccount,
  getVirtualAccount,
  listVirtualAccounts,
  deactivateVirtualAccount,
} from '../lib/virtualAccountStore';
import { getDepositInstruction, listDepositInstructions } from '../lib/depositConfig';
import { gtp } from '../lib/gtpClient';
import { getTransactions } from '../lib/ledger';

const router = Router();

const SUPPORTED_CURRENCIES = ['CAD', 'USD', 'GBP', 'EUR', 'NGN'];

const createSchema = z.object({
  customer_id:   z.string().min(1).max(100),
  customer_name: z.string().min(1).max(200),
  currency:      z.string().length(3).toUpperCase().refine(
    c => SUPPORTED_CURRENCIES.includes(c),
    c => ({ message: `Currency ${c} is not supported. Supported: ${SUPPORTED_CURRENCIES.join(', ')}` }),
  ),
  description:   z.string().max(255).optional(),
  metadata:      z.record(z.unknown()).optional(),
});

// ── Deposit instructions helper ────────────────────────────────────────────
// Returns the bank account details for a currency, plus the virtual account's
// unique reference code that the customer MUST include in the payment.

async function buildDepositInstructions(currency: string, referenceCode: string) {
  // Admin-configured instructions take priority over GTP wallet data
  const adminInst = await getDepositInstruction(currency).catch(() => null);

  let base: Record<string, unknown> = { currency };

  if (adminInst && adminInst.enabled) {
    base = {
      currency:       adminInst.currency,
      bank_name:      adminInst.bank_name,
      account_name:   adminInst.account_name,
      account_number: adminInst.account_number,
      ...(adminInst.iban       ? { iban: adminInst.iban }             : {}),
      ...(adminInst.swift      ? { swift: adminInst.swift }           : {}),
      ...(adminInst.sort_code  ? { sort_code: adminInst.sort_code }   : {}),
      ...(adminInst.send_to_email ? { send_to_email: adminInst.send_to_email } : {}),
    };
  } else {
    // Fall back to GTP wallet data
    try {
      const { data } = await gtp.get(`/wallets/${currency}`);
      const w = data.data?.wallet as Record<string, unknown> | undefined;
      if (w) {
        base = {
          currency,
          bank_name:      w.bank_name ?? 'See Zeeh deposit account',
          account_name:   w.account_name ?? 'Zeeh Africa',
          account_number: w.account_number,
        };
      }
    } catch { /* use minimal base */ }
  }

  // Currency-specific payment method label
  const methodMap: Record<string, string> = {
    CAD: 'Interac eTransfer',
    GBP: 'Faster Payments (FPS)',
    EUR: 'SEPA Transfer',
    USD: 'Wire Transfer (ACH)',
    NGN: 'Bank Transfer',
  };

  return {
    ...base,
    method:         methodMap[currency] ?? 'Bank Transfer',
    reference_code: referenceCode,
    instructions:   `Include exactly "${referenceCode}" as the payment reference/description. This is how we match your deposit to your account.`,
  };
}

// ── POST /api/virtual-accounts ─────────────────────────────────────────────
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Validation error', errors: parsed.error.flatten() });
      return;
    }

    const clientId   = req.apiClient!.key_id;
    const clientName = req.apiClient!.client_name;

    const account = await createVirtualAccount(clientId, clientName, parsed.data);
    const deposit = await buildDepositInstructions(account.currency, account.reference_code);

    res.status(201).json({
      success: true,
      message: 'Virtual account created. Share the deposit instructions with your customer.',
      data: {
        virtual_account: {
          account_id:     account.account_id,
          customer_id:    account.customer_id,
          customer_name:  account.customer_name,
          currency:       account.currency,
          reference_code: account.reference_code,
          status:         account.status,
          total_credited: account.total_credited,
          created_at:     account.created_at,
        },
        deposit_instructions: deposit,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/virtual-accounts ──────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = req.apiClient!.key_id;
    const currency = req.query.currency ? String(req.query.currency).toUpperCase() : undefined;
    const status   = req.query.status   ? String(req.query.status)                 : undefined;
    const limit    = req.query.limit    ? parseInt(String(req.query.limit), 10)    : 50;

    const accounts = await listVirtualAccounts(clientId, { currency, status, limit });

    res.json({
      success: true,
      data: {
        virtual_accounts: accounts.map(a => ({
          account_id:     a.account_id,
          customer_id:    a.customer_id,
          customer_name:  a.customer_name,
          currency:       a.currency,
          reference_code: a.reference_code,
          status:         a.status,
          total_credited: a.total_credited,
          created_at:     a.created_at,
        })),
        count: accounts.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/virtual-accounts/:account_id ─────────────────────────────────
router.get('/:account_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = req.apiClient!.key_id;
    const account  = await getVirtualAccount(req.params.account_id);

    if (!account || account.client_id !== clientId) {
      res.status(404).json({ success: false, message: 'Virtual account not found.' });
      return;
    }

    const deposit = await buildDepositInstructions(account.currency, account.reference_code);

    res.json({
      success: true,
      data: {
        virtual_account: {
          account_id:     account.account_id,
          customer_id:    account.customer_id,
          customer_name:  account.customer_name,
          currency:       account.currency,
          reference_code: account.reference_code,
          status:         account.status,
          description:    account.description,
          metadata:       account.metadata,
          total_credited: account.total_credited,
          created_at:     account.created_at,
          updated_at:     account.updated_at,
        },
        deposit_instructions: deposit,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/virtual-accounts/:account_id ──────────────────────────────
router.delete('/:account_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = req.apiClient!.key_id;

    // Ownership check before deactivating
    const account = await getVirtualAccount(req.params.account_id);
    if (!account || account.client_id !== clientId) {
      res.status(404).json({ success: false, message: 'Virtual account not found.' });
      return;
    }
    if (account.status === 'inactive') {
      res.status(400).json({ success: false, message: 'Virtual account is already inactive.' });
      return;
    }

    await deactivateVirtualAccount(req.params.account_id, clientId);
    res.json({ success: true, message: 'Virtual account deactivated. No further deposits will be credited to it.' });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/virtual-accounts/:account_id/transactions ────────────────────
// Returns ledger credits that reference this virtual account's reference_code
router.get('/:account_id/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = req.apiClient!.key_id;
    const account  = await getVirtualAccount(req.params.account_id);

    if (!account || account.client_id !== clientId) {
      res.status(404).json({ success: false, message: 'Virtual account not found.' });
      return;
    }

    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
    const allTxns = await getTransactions(clientId, 500);

    // Filter to only credits matching this virtual account's reference code
    const txns = allTxns
      .filter(t => t.direction === 'credit' && t.reference === account.reference_code)
      .slice(0, limit);

    res.json({
      success: true,
      data: {
        account_id:  account.account_id,
        customer_id: account.customer_id,
        currency:    account.currency,
        transactions: txns.map(t => ({
          txn_id:        t.txn_id,
          amount:        t.amount,
          currency:      t.currency,
          balance_after: t.balance_after,
          description:   t.description,
          created_at:    t.created_at,
        })),
        count: txns.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
