import { Router, Request, Response, NextFunction } from 'express';
import { gtp } from '../lib/gtpClient';
import { listFrozen } from '../lib/circuitBreaker';

const router = Router();

// Static metadata per currency code.
// payout_status:
//   'active'              — fully supported, all fields documented
//   'contact_support'     — rail exists but not yet self-serve (GBP/EUR pending Expedier activation)
//   'coming_soon'         — not yet available
interface FieldSpec {
  field:       string;
  type:        string;
  required:    boolean;
  description: string;
}

interface CurrencyMeta {
  name:           string;
  flag:           string;
  payout_status:  'active' | 'contact_support' | 'coming_soon';
  payout_fields:  FieldSpec[];
}

const CURRENCY_META: Record<string, CurrencyMeta> = {
  // ── Expedier (CAD/NGN/USD) ────────────────────────────────────────────────
  CAD: {
    name:          'Canadian Dollar',
    flag:          '🇨🇦',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_email', type: 'string', required: true,  description: 'Recipient Interac e-Transfer email address' },
      { field: 'account_name',    type: 'string', required: false, description: 'Recipient full name (recommended)' },
    ],
  },
  NGN: {
    name:          'Nigerian Naira',
    flag:          '🇳🇬',
    payout_status: 'active',
    payout_fields: [
      { field: 'bank_id',        type: 'number', required: true, description: 'Bank ID from GET /api/account/banks' },
      { field: 'account_number', type: 'string', required: true, description: '10-digit NUBAN account number' },
      { field: 'account_name',   type: 'string', required: true, description: 'Account holder name as registered with the bank' },
    ],
  },
  USD: {
    name:          'US Dollar',
    flag:          '🇺🇸',
    payout_status: 'active',
    payout_fields: [
      { field: 'bank_name',      type: 'string',           required: true,  description: 'Recipient bank name' },
      { field: 'account_number', type: 'string',           required: true,  description: 'Bank account number' },
      { field: 'routing_number', type: 'string',           required: true,  description: '9-digit ACH routing number' },
      { field: 'account_type',   type: 'checking|savings', required: true,  description: '"checking" or "savings"' },
      { field: 'email',          type: 'string',           required: false, description: 'Recipient email address' },
      { field: 'address',        type: 'string',           required: false, description: 'Recipient street address' },
      { field: 'city',           type: 'string',           required: false, description: 'Recipient city' },
      { field: 'state_id',       type: 'number',           required: false, description: 'US state ID from GET /api/account/states' },
      { field: 'postal_code',    type: 'string',           required: false, description: 'ZIP code' },
    ],
  },
  GBP: {
    name:          'British Pound',
    flag:          '🇬🇧',
    payout_status: 'contact_support',
    payout_fields: [
      { field: 'account_number', type: 'string', required: true, description: '8-digit UK account number' },
      { field: 'sort_code',      type: 'string', required: true, description: '6-digit sort code (format: XX-XX-XX)' },
      { field: 'account_name',   type: 'string', required: true, description: 'Account holder full name' },
    ],
  },
  EUR: {
    name:          'Euro',
    flag:          '🇪🇺',
    payout_status: 'contact_support',
    payout_fields: [
      { field: 'iban',         type: 'string', required: true,  description: 'IBAN (up to 34 chars, e.g. DE89370400440532013000)' },
      { field: 'bic',          type: 'string', required: false, description: 'BIC / SWIFT code' },
      { field: 'account_name', type: 'string', required: true,  description: 'Account holder full name' },
    ],
  },

  // ── Flutterwave — Africa bank transfer ────────────────────────────────────
  GHS: {
    name:          'Ghanaian Cedi',
    flag:          '🇬🇭',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true, description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true, description: 'Recipient last name' },
      { field: 'account_number',       type: 'string', required: true, description: 'Bank account number' },
      { field: 'account_bank',         type: 'string', required: true, description: 'Bank code — see GET /api/account/banks/GH' },
    ],
  },
  ZAR: {
    name:          'South African Rand',
    flag:          '🇿🇦',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true,  description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true,  description: 'Recipient last name' },
      { field: 'account_number',       type: 'string', required: true,  description: 'Bank account number' },
      { field: 'account_bank',         type: 'string', required: true,  description: 'Bank code — see GET /api/account/banks/ZA' },
      { field: 'recipient_email',      type: 'string', required: true,  description: 'Recipient email (required by ZAR compliance)' },
      { field: 'recipient_phone',      type: 'string', required: false, description: 'Recipient phone number (digits only, no country code)' },
      { field: 'recipient_address',    type: 'string', required: false, description: 'Recipient street address' },
      { field: 'recipient_city',       type: 'string', required: false, description: 'Recipient city' },
      { field: 'recipient_postal_code',type: 'string', required: false, description: 'Postal code' },
    ],
  },
  EGP: {
    name:          'Egyptian Pound',
    flag:          '🇪🇬',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true, description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true, description: 'Recipient last name' },
      { field: 'account_number',       type: 'string', required: true, description: 'Bank account number' },
      { field: 'account_bank',         type: 'string', required: true, description: 'Bank code — see GET /api/account/banks/EG' },
    ],
  },
  ETB: {
    name:          'Ethiopian Birr',
    flag:          '🇪🇹',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true, description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true, description: 'Recipient last name' },
      { field: 'account_number',       type: 'string', required: true, description: 'Bank account number' },
      { field: 'account_bank',         type: 'string', required: true, description: 'Bank code — see GET /api/account/banks/ET' },
    ],
  },
  MWK: {
    name:          'Malawian Kwacha',
    flag:          '🇲🇼',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true, description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true, description: 'Recipient last name' },
      { field: 'account_number',       type: 'string', required: true, description: 'Bank account number' },
      { field: 'account_bank',         type: 'string', required: true, description: 'Bank code — see GET /api/account/banks/MW' },
    ],
  },

  // ── Flutterwave — Africa mobile money ─────────────────────────────────────
  KES: {
    name:          'Kenyan Shilling',
    flag:          '🇰🇪',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true,  description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true,  description: 'Recipient last name' },
      { field: 'msisdn',               type: 'string', required: true,  description: 'Phone number with country code e.g. 254712345678' },
      { field: 'mobile_network',       type: 'string', required: false, description: 'Mobile network (default: Safaricom / M-Pesa)' },
    ],
  },
  TZS: {
    name:          'Tanzanian Shilling',
    flag:          '🇹🇿',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true,  description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true,  description: 'Recipient last name' },
      { field: 'msisdn',               type: 'string', required: true,  description: 'Phone number with country code e.g. 255712345678' },
      { field: 'mobile_network',       type: 'string', required: false, description: 'Mobile network (default: Airtel)' },
    ],
  },
  UGX: {
    name:          'Ugandan Shilling',
    flag:          '🇺🇬',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true,  description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true,  description: 'Recipient last name' },
      { field: 'msisdn',               type: 'string', required: true,  description: 'Phone number with country code e.g. 256701234567' },
      { field: 'mobile_network',       type: 'string', required: false, description: 'Mobile network (default: MTN)' },
    ],
  },
  RWF: {
    name:          'Rwandan Franc',
    flag:          '🇷🇼',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true,  description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true,  description: 'Recipient last name' },
      { field: 'msisdn',               type: 'string', required: true,  description: 'Phone number with country code e.g. 250781234567' },
      { field: 'mobile_network',       type: 'string', required: false, description: 'Mobile network (default: MTN)' },
    ],
  },
  ZMW: {
    name:          'Zambian Kwacha',
    flag:          '🇿🇲',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true,  description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true,  description: 'Recipient last name' },
      { field: 'msisdn',               type: 'string', required: true,  description: 'Phone number with country code e.g. 260971234567' },
      { field: 'mobile_network',       type: 'string', required: false, description: 'Mobile network (default: Airtel)' },
    ],
  },
  XAF: {
    name:          'Central African CFA Franc',
    flag:          '🇨🇲',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true,  description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true,  description: 'Recipient last name' },
      { field: 'msisdn',               type: 'string', required: true,  description: 'Phone number with country code e.g. 237671234567' },
      { field: 'mobile_network',       type: 'string', required: false, description: 'Mobile network (default: Orange)' },
    ],
  },
  XOF: {
    name:          'West African CFA Franc',
    flag:          '🇨🇮',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true,  description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true,  description: 'Recipient last name' },
      { field: 'msisdn',               type: 'string', required: true,  description: 'Phone number with country code' },
      { field: 'mobile_network',       type: 'string', required: false, description: 'Mobile network (default: Wave). Also supports: Orange, eMoney' },
    ],
  },
  SLL: {
    name:          'Sierra Leonean Leone',
    flag:          '🇸🇱',
    payout_status: 'active',
    payout_fields: [
      { field: 'recipient_first_name', type: 'string', required: true,  description: 'Recipient first name' },
      { field: 'recipient_last_name',  type: 'string', required: true,  description: 'Recipient last name' },
      { field: 'msisdn',               type: 'string', required: true,  description: 'Phone number with country code e.g. 23276123456' },
      { field: 'mobile_network',       type: 'string', required: false, description: 'Mobile network (default: Africell)' },
    ],
  },
};

// GET /api/currencies
// Returns all supported currencies with their payout status and required transfer fields.
// Derives the list from live Expedier rates — currencies not on Expedier rails are excluded.
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [ratesResult, frozenResult] = await Promise.allSettled([
      gtp.get('/rates'),
      listFrozen(),
    ]);

    // Build set of currencies from live rate pairs
    const seen = new Set<string>();
    if (ratesResult.status === 'fulfilled') {
      const pairs = (ratesResult.value.data?.data?.rates ?? []) as Array<{
        from_currency: string;
        to_currency:   string;
      }>;
      for (const p of pairs) {
        seen.add(p.from_currency);
        seen.add(p.to_currency);
      }
    } else {
      // GTP unavailable — fall back to our static metadata keys
      Object.keys(CURRENCY_META).forEach(c => seen.add(c));
    }

    const frozenSet = new Set(
      (frozenResult.status === 'fulfilled' ? frozenResult.value : []).map(f => f.currency),
    );

    const currencies = [...seen].sort().map(code => {
      const meta = CURRENCY_META[code];
      const isFrozen = frozenSet.has(code);

      const status = isFrozen
        ? ('temporarily_suspended' as const)
        : (meta?.payout_status ?? 'contact_support');

      return {
        code,
        name:          meta?.name ?? code,
        flag:          meta?.flag ?? '🌍',
        payout_status: status,
        payout_fields: meta?.payout_fields ?? [],
        ...(isFrozen
          ? { note: 'Payouts temporarily suspended. Please retry later.' }
          : status === 'contact_support'
            ? { note: 'Contact support@zeehfi.ca to enable payouts for this currency.' }
            : {}),
      };
    });

    res.json({
      success: true,
      data: {
        currencies,
        total:                 currencies.length,
        active_payout_count:  currencies.filter(c => c.payout_status === 'active').length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/currencies/:code — single currency detail + required transfer fields
router.get('/:code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const code = req.params.code.toUpperCase();
    const meta = CURRENCY_META[code];

    if (!meta) {
      res.status(404).json({
        success: false,
        message: `${code} is not a supported currency. Call GET /api/currencies for the full list.`,
      });
      return;
    }

    const frozen    = await listFrozen();
    const isFrozen  = frozen.some(f => f.currency === code);
    const status    = isFrozen ? 'temporarily_suspended' : meta.payout_status;

    res.json({
      success: true,
      data: {
        code,
        name:          meta.name,
        flag:          meta.flag,
        payout_status: status,
        payout_fields: meta.payout_fields,
        ...(isFrozen
          ? { note: 'Payouts temporarily suspended. Please retry later.' }
          : status === 'contact_support'
            ? { note: 'Contact support@zeehfi.ca to enable payouts for this currency.' }
            : {}),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
