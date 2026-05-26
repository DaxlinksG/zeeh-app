import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createApiKey, listApiKeys, revokeApiKey } from '../lib/keyStore';
import { creditBalance, getAllBalances, getTransactions } from '../lib/ledger';
import { listPendingDeposits, assignDeposit, ignoreDeposit } from '../lib/deposits';

const router = Router();

// All admin routes require the ADMIN_KEY header (separate from client API keys)
router.use((req: Request, res: Response, next: NextFunction) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(503).json({ success: false, message: 'Admin not configured' });
    return;
  }
  if (req.headers['x-admin-key'] !== adminKey) {
    res.status(401).json({ success: false, message: 'Invalid admin key' });
    return;
  }
  next();
});

const createKeySchema = z.object({
  client_name:  z.string().min(2).max(100),
  client_email: z.string().email(),
});

// POST /admin/keys — create a new API key for a client
router.post('/keys', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() });
      return;
    }

    const { record, rawKey } = await createApiKey(parsed.data.client_name, parsed.data.client_email);

    res.status(201).json({
      success: true,
      message: 'API key created. Save the api_key now — it will never be shown again.',
      data: {
        api_key:      rawKey,           // shown ONCE
        key_id:       record.key_id,
        client_name:  record.client_name,
        client_email: record.client_email,
        created_at:   record.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/keys — list all keys (hashes never returned)
router.get('/keys', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const keys = await listApiKeys();
    res.json({ success: true, data: { keys, count: keys.length } });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/keys/:key_id — revoke a key
router.delete('/keys/:key_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const revoked = await revokeApiKey(req.params.key_id);
    if (!revoked) {
      res.status(404).json({ success: false, message: 'Key not found' });
      return;
    }
    res.json({ success: true, message: `Key ${req.params.key_id} revoked` });
  } catch (err) {
    next(err);
  }
});

// ── Ledger: credit a client after deposit ────────────────────────────────
const creditSchema = z.object({
  key_id:      z.string().min(1),
  currency:    z.string().length(3).toUpperCase(),
  amount:      z.string().regex(/^\d+(\.\d{1,2})?$/),
  reference:   z.string().min(1).max(100),
  description: z.string().max(255).optional(),
});

// POST /admin/ledger/credit — called after a client deposit clears
router.post('/ledger/credit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = creditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() });
      return;
    }
    const { key_id, currency, amount, reference, description } = parsed.data;
    const balance = await creditBalance(
      key_id, currency, amount, reference,
      description ?? `Manual deposit ${amount} ${currency}`,
      { credited_by: 'admin' },
    );
    res.json({
      success: true,
      message: `Credited ${amount} ${currency} to ${key_id}`,
      data: { balance },
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ledger/:key_id — view a client's balances
router.get('/ledger/:key_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const balances = await getAllBalances(req.params.key_id);
    res.json({ success: true, data: { key_id: req.params.key_id, balances } });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ledger/:key_id/transactions — client's full ledger history
router.get('/ledger/:key_id/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string ?? '50', 10), 200);
    const txns  = await getTransactions(req.params.key_id, limit);
    res.json({ success: true, data: { transactions: txns, count: txns.length } });
  } catch (err) {
    next(err);
  }
});

// ── Pending Deposits ──────────────────────────────────────────────────────

// GET /admin/deposits/pending  — list unassigned deposits
router.get('/deposits/pending', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const deposits = await listPendingDeposits('unassigned');
    res.json({ success: true, data: { deposits, count: deposits.length } });
  } catch (err) {
    next(err);
  }
});

// GET /admin/deposits/all  — list all deposits regardless of status
router.get('/deposits/all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = (req.query.status as string) ?? 'unassigned';
    const validStatuses = ['unassigned', 'assigned', 'ignored'] as const;
    type DS = typeof validStatuses[number];
    const s: DS = validStatuses.includes(status as DS) ? (status as DS) : 'unassigned';
    const deposits = await listPendingDeposits(s);
    res.json({ success: true, data: { deposits, count: deposits.length } });
  } catch (err) {
    next(err);
  }
});

const assignSchema = z.object({
  key_id: z.string().min(1),
});

// POST /admin/deposits/:deposit_id/assign  — assign to client & credit their ledger
router.post('/deposits/:deposit_id/assign', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() });
      return;
    }
    const deposit = await assignDeposit(req.params.deposit_id, parsed.data.key_id, 'admin');
    res.json({
      success: true,
      message: `Deposit ${deposit.deposit_id} assigned and ${deposit.currency} ${deposit.amount} credited to ${deposit.assigned_to}`,
      data: { deposit },
    });
  } catch (err: unknown) {
    if (err instanceof Error && (err.message.includes('not found') || err.message.includes('already'))) {
      res.status(400).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
});

// POST /admin/deposits/:deposit_id/ignore  — mark as ignored (internal / test)
router.post('/deposits/:deposit_id/ignore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ignoreDeposit(req.params.deposit_id);
    res.json({ success: true, message: `Deposit ${req.params.deposit_id} marked as ignored` });
  } catch (err: unknown) {
    if (err instanceof Error && (err.message.includes('not found') || err.message.includes('already'))) {
      res.status(400).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
});

export default router;
