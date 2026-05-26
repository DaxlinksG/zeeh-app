import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createApiKey, listApiKeys, revokeApiKey, getApiKeyById } from '../lib/keyStore';
import { creditBalance, getAllBalances, getTransactions } from '../lib/ledger';
import { listPendingDeposits, assignDeposit, ignoreDeposit, getDeposit } from '../lib/deposits';
import { listUsers, listPendingKyc, getKyc, updateKycStatus, getUserById } from '../lib/userStore';
import { listDepositInstructions, getDepositInstruction, putDepositInstruction, deleteDepositInstruction } from '../lib/depositConfig';
import { freezeCurrency, unfreezeCurrency, listFrozen, isFrozen } from '../lib/circuitBreaker';
import {
  sendApiKeyCreated, sendApiKeyRevoked,
  sendKycApproved, sendKycRejected,
  sendDepositCredited,
} from '../lib/mailer';

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

    // Email API key to client (fire-and-forget — includes the raw key shown once)
    sendApiKeyCreated(record.client_email, record.client_name, record.key_id, rawKey);

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
    // Look up before revoking so we have email for notification
    const keyRecord = await getApiKeyById(req.params.key_id);
    const revoked   = await revokeApiKey(req.params.key_id);
    if (!revoked) {
      res.status(404).json({ success: false, message: 'Key not found' });
      return;
    }

    // Email client (fire-and-forget)
    if (keyRecord) sendApiKeyRevoked(keyRecord.client_email, keyRecord.client_name, req.params.key_id);

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

// ── Users & KYC ──────────────────────────────────────────────────────────

// GET /admin/users — list all B2C users
router.get('/users', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await listUsers(200);
    res.json({ success: true, data: { users, count: users.length } });
  } catch (err) { next(err); }
});

// GET /admin/users/kyc/pending — list submissions awaiting review
router.get('/users/kyc/pending', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const records = await listPendingKyc();
    res.json({ success: true, data: { records, count: records.length } });
  } catch (err) { next(err); }
});

// GET /admin/users/:user_id/kyc — full KYC record for one user
router.get('/users/:user_id/kyc', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const record = await getKyc(req.params.user_id);
    if (!record) { res.status(404).json({ success: false, message: 'KYC record not found' }); return; }
    res.json({ success: true, data: record });
  } catch (err) { next(err); }
});

const kycActionSchema = z.object({
  notes: z.string().max(500).optional(),
});

// POST /admin/users/:user_id/kyc/approve
router.post('/users/:user_id/kyc/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = kycActionSchema.safeParse(req.body);
    const notes  = parsed.success ? parsed.data.notes : undefined;
    await updateKycStatus(req.params.user_id, 'approved', notes);

    // Email user (fire-and-forget)
    getUserById(req.params.user_id).then(u => {
      if (u) sendKycApproved(u.email, u.first_name);
    }).catch(() => {});

    res.json({ success: true, message: `KYC approved for ${req.params.user_id}` });
  } catch (err) { next(err); }
});

// POST /admin/users/:user_id/kyc/reject
router.post('/users/:user_id/kyc/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = kycActionSchema.safeParse(req.body);
    const notes  = parsed.success ? parsed.data.notes : 'Rejected by admin';
    await updateKycStatus(req.params.user_id, 'rejected', notes);

    // Email user (fire-and-forget)
    getUserById(req.params.user_id).then(u => {
      if (u) sendKycRejected(u.email, u.first_name, notes ?? 'Please resubmit with valid documents');
    }).catch(() => {});

    res.json({ success: true, message: `KYC rejected for ${req.params.user_id}` });
  } catch (err) { next(err); }
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

    // Email the client (fire-and-forget)
    getApiKeyById(parsed.data.key_id).then(async keyRec => {
      if (!keyRec) return;
      // Fetch new balance for the email
      const { getAllBalances } = await import('../lib/ledger');
      const balances  = await getAllBalances(parsed.data.key_id).catch(() => []);
      const balEntry  = balances.find(b => b.currency === deposit.currency);
      const newBalance = balEntry ? balEntry.balance : deposit.amount;
      sendDepositCredited(keyRec.client_email, keyRec.client_name, deposit.currency, deposit.amount, newBalance);
    }).catch(() => {});

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

// ── Deposit Instructions (admin-configurable per-currency bank details) ──────

const depositInstructionSchema = z.object({
  bank_name:      z.string().max(120).optional(),
  account_name:   z.string().max(120).optional(),
  account_number: z.string().max(60).optional(),
  iban:           z.string().max(40).optional(),
  swift:          z.string().max(20).optional(),
  sort_code:      z.string().max(20).optional(),
  send_to_email:  z.string().email().optional(),
  wallet_id:      z.string().max(80).optional(),
  enabled:        z.boolean().optional().default(true),
});

// GET /admin/deposit-instructions
router.get('/deposit-instructions', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const instructions = await listDepositInstructions();
    res.json({ success: true, data: { instructions, count: instructions.length } });
  } catch (err) { next(err); }
});

// GET /admin/deposit-instructions/:currency
router.get('/deposit-instructions/:currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await getDepositInstruction(req.params.currency);
    if (!item) { res.status(404).json({ success: false, message: 'Not found' }); return; }
    res.json({ success: true, data: item });
  } catch (err) { next(err); }
});

// PUT /admin/deposit-instructions/:currency  — create or replace
router.put('/deposit-instructions/:currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currency = req.params.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      res.status(400).json({ success: false, message: 'currency must be a 3-letter code e.g. NGN' }); return;
    }
    const parsed = depositInstructionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }
    const item = await putDepositInstruction({ ...parsed.data, currency });
    res.json({ success: true, message: `Deposit instructions saved for ${currency}`, data: item });
  } catch (err) { next(err); }
});

// DELETE /admin/deposit-instructions/:currency
router.delete('/deposit-instructions/:currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteDepositInstruction(req.params.currency);
    res.json({ success: true, message: `Deposit instructions removed for ${req.params.currency.toUpperCase()}` });
  } catch (err) { next(err); }
});

// ── Circuit Breakers ─────────────────────────────────────────────────────────
// Auto-set by treasury reconciliation; manually overrideable by admin.
// Frozen currencies block outflows (swap, transfer, send) but allow inflows.

// GET /admin/circuit-breakers — list all active freezes
router.get('/circuit-breakers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const frozen = await listFrozen();
    res.json({
      success: true,
      data: {
        frozen,
        count: frozen.length,
        note: 'Frozen currencies block swap/transfer/send outflows. Deposits still accepted.',
      },
    });
  } catch (err) { next(err); }
});

// GET /admin/circuit-breakers/:currency — check one currency
router.get('/circuit-breakers/:currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currency = req.params.currency.toUpperCase();
    const frozen   = await isFrozen(currency);
    res.json({ success: true, data: { currency, frozen } });
  } catch (err) { next(err); }
});

const freezeSchema = z.object({
  reason: z.string().min(5).max(300),
});

// POST /admin/circuit-breakers/:currency/freeze — manually trip a breaker
router.post('/circuit-breakers/:currency/freeze', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currency = req.params.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      res.status(400).json({ success: false, message: 'currency must be a 3-letter code' }); return;
    }
    const parsed = freezeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() }); return;
    }
    const record = await freezeCurrency(currency, parsed.data.reason, 'admin_manual');
    res.json({
      success: true,
      message: `${currency} outflows are now frozen`,
      data: record,
    });
  } catch (err) { next(err); }
});

// DELETE /admin/circuit-breakers/:currency — manually lift a breaker
router.delete('/circuit-breakers/:currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currency = req.params.currency.toUpperCase();
    await unfreezeCurrency(currency);
    res.json({ success: true, message: `${currency} outflows restored` });
  } catch (err) { next(err); }
});

export default router;
