import { Router, Request, Response, NextFunction } from 'express';
import { gtp } from '../lib/gtpClient';
import { listDepositInstructions, getDepositInstruction } from '../lib/depositConfig';

const router = Router();

// Helper — extract clean deposit instructions from GTP wallet data
function extractDepositInstructions(wallet: Record<string, unknown>) {
  const currency = wallet.currency as string;
  const bank = wallet.user_bank_details as Record<string, unknown> | null;
  const ddt  = wallet.ddt_assignment  as Record<string, unknown> | null;

  if (!bank) return null;

  const base = {
    currency,
    bank_name:      bank.bank_name,
    account_name:   bank.account_name,
    account_number: bank.account_number,
    verified:       bank.verified,
  };

  // Currency-specific instructions
  switch (currency) {
    case 'CAD':
      return {
        ...base,
        method:        'Interac eTransfer',
        send_to_email: bank.account_number,
        ddt_number:    ddt?.ddt_number ?? null,
        instructions:  'Send an Interac eTransfer to the email above. Funds settle within minutes.',
      };
    case 'NGN':
      return {
        ...base,
        method:       'Bank Transfer',
        instructions: 'Transfer to the account number above via any Nigerian bank or mobile app.',
      };
    case 'GBP':
      return {
        ...base,
        method:       'Faster Payments (FPS)',
        instructions: 'Send a Faster Payments transfer to the account number above. Funds settle same day.',
      };
    case 'EUR':
      return {
        ...base,
        method:       'SEPA Transfer',
        iban:         bank.account_number,
        instructions: 'Send a SEPA transfer to the IBAN above. Funds settle within 1 business day.',
      };
    case 'USD':
      return {
        ...base,
        method:       'Wire Transfer (ACH)',
        instructions: 'Send a domestic wire or ACH transfer to the account number above.',
      };
    default:
      return base;
  }
}

// GET /api/wallets
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/wallets');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/wallets/balances
router.get('/balances', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/wallets/balances');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/wallets/deposit — all deposit instructions (on-ramp)
// Merges GTP wallet data with admin-configured overrides (admin wins per currency)
router.get('/deposit', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Fetch both sources in parallel; GTP failure is non-fatal
    const [gtpResult, adminInstructions] = await Promise.allSettled([
      gtp.get('/wallets'),
      listDepositInstructions(),
    ]);

    // Start with GTP wallet instructions
    const byCode = new Map<string, Record<string, unknown>>();
    if (gtpResult.status === 'fulfilled') {
      const wallets = (gtpResult.value.data?.data?.wallets ?? []) as Record<string, unknown>[];
      for (const w of wallets) {
        if (w.status === 'approved' && w.active) {
          const inst = extractDepositInstructions(w);
          if (inst) {
            const code = (typeof w.currency === 'object' && w.currency !== null)
              ? String((w.currency as Record<string, unknown>).code ?? '').toUpperCase()
              : String(w.currency ?? '').toUpperCase();
            if (code) byCode.set(code, inst as Record<string, unknown>);
          }
        }
      }
    }

    // Admin-configured instructions WIN — they override GTP or add new currencies
    if (adminInstructions.status === 'fulfilled') {
      for (const ai of adminInstructions.value) {
        if (!ai.enabled) continue;
        const override: Record<string, unknown> = {
          currency:       ai.currency,
          bank_name:      ai.bank_name,
          account_name:   ai.account_name,
          account_number: ai.account_number,
          iban:           ai.iban,
          swift:          ai.swift,
          sort_code:      ai.sort_code,
          send_to_email:  ai.send_to_email,
          wallet_id:      ai.wallet_id,
          source:         'admin_configured',
        };
        // Remove undefined fields
        Object.keys(override).forEach(k => override[k] === undefined && delete override[k]);
        byCode.set(ai.currency, override);
      }
    }

    res.json({
      success: true,
      message: 'Send funds to any of these accounts to top up your balance.',
      data: { deposit_accounts: [...byCode.values()] },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/wallets/deposit/:currency — deposit instructions for one currency
router.get('/deposit/:currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currency = req.params.currency.toUpperCase();

    // Admin config takes priority
    const adminInst = await getDepositInstruction(currency).catch(() => null);
    if (adminInst && adminInst.enabled) {
      const result: Record<string, unknown> = {
        currency:       adminInst.currency,
        bank_name:      adminInst.bank_name,
        account_name:   adminInst.account_name,
        account_number: adminInst.account_number,
        iban:           adminInst.iban,
        swift:          adminInst.swift,
        sort_code:      adminInst.sort_code,
        send_to_email:  adminInst.send_to_email,
        wallet_id:      adminInst.wallet_id,
        source:         'admin_configured',
      };
      Object.keys(result).forEach(k => result[k] === undefined && delete result[k]);
      res.json({ success: true, data: { deposit_account: result } }); return;
    }

    // Fall back to GTP wallet data
    const { data } = await gtp.get('/wallets');
    const wallets = (data.data?.wallets ?? []) as Record<string, unknown>[];
    const wallet  = wallets.find((w) => {
      const wCur = (typeof w.currency === 'object' && w.currency !== null)
        ? String((w.currency as Record<string, unknown>).code ?? '').toUpperCase()
        : String(w.currency ?? '').toUpperCase();
      return wCur === currency;
    });

    if (!wallet) {
      res.status(404).json({ success: false, message: `No active ${currency} deposit account found. Contact support to set one up.` }); return;
    }

    const instructions = extractDepositInstructions(wallet);
    res.json({ success: true, data: { deposit_account: instructions } });
  } catch (err) {
    next(err);
  }
});

// GET /api/wallets/:currency/transactions
router.get('/:currency/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get(`/wallets/${req.params.currency.toUpperCase()}/transactions`, { params: req.query });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/wallets/:currency
router.get('/:currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get(`/wallets/${req.params.currency.toUpperCase()}`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
