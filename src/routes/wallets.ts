import { Router, Request, Response, NextFunction } from 'express';
import { gtp } from '../lib/gtpClient';

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
router.get('/deposit', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/wallets');
    const wallets = (data.data?.wallets ?? []) as Record<string, unknown>[];

    const instructions = wallets
      .filter((w) => w.status === 'approved' && w.active)
      .map(extractDepositInstructions)
      .filter(Boolean);

    res.json({
      success: true,
      message: 'Send funds to any of these accounts to top up your wallet.',
      data: { deposit_accounts: instructions },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/wallets/deposit/:currency — deposit instructions for one currency
router.get('/deposit/:currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const currency = req.params.currency.toUpperCase();
    const { data } = await gtp.get('/wallets');
    const wallets = (data.data?.wallets ?? []) as Record<string, unknown>[];
    const wallet  = wallets.find((w) => w.currency === currency);

    if (!wallet) {
      res.status(404).json({ success: false, message: `No active ${currency} wallet found` });
      return;
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
