export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Zeeh Africa — Payments API',
    version: '1.1.0',
    description: `
## Overview
**Zeeh Africa** provides a fast, affordable API for cross-border money movement across Africa and beyond — covering Canada, Nigeria, the US, UK, Europe, and 13+ African payout corridors.

---

## Quick Start

\`\`\`bash
# 1. See all supported payout currencies
curl https://api.zeehfi.ca/api/currencies \\
  -H "x-api-key: YOUR_KEY"

# 2. Get a live rate
curl https://api.zeehfi.ca/api/rates/CAD/NGN \\
  -H "x-api-key: YOUR_KEY"

# 3. Preview a conversion
curl "https://api.zeehfi.ca/api/rates/convert?amount=500&from_currency=CAD&to_currency=NGN" \\
  -H "x-api-key: YOUR_KEY"

# 4. Send money
curl -X POST https://api.zeehfi.ca/api/transfers \\
  -H "x-api-key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":"500.00","currency":"NGN","bank_id":10,"account_number":"0123456789","account_name":"John Doe","client_reference":"TRF-001"}'
\`\`\`

---

## Authentication

Every request (except \`/health\`) requires your API key in the header:

\`\`\`
x-api-key: YOUR_API_KEY
\`\`\`

Contact **zeehafricah@gmail.com** to get your key.

---

## Rate Limits

| Scope | Limit |
|---|---|
| Global | 120 req / min |
| Transfers & Swaps | 20 req / min |
| Rates | 300 req / min |

Returns **HTTP 429** when exceeded. Retry after 60 seconds.

---

## Supported Payout Corridors

### North America & Europe
| Currency | Method |
|---|---|
| 🇨🇦 CAD | Interac eTransfer |
| 🇳🇬 NGN | Bank Transfer |
| 🇺🇸 USD | Wire / ACH |
| 🇬🇧 GBP | Contact support |
| 🇪🇺 EUR | Contact support |

### Africa — Bank Transfer
| Currency | Country |
|---|---|
| 🇬🇭 GHS | Ghana |
| 🇿🇦 ZAR | South Africa |
| 🇪🇬 EGP | Egypt |
| 🇪🇹 ETB | Ethiopia |
| 🇲🇼 MWK | Malawi |

### Africa — Mobile Money
| Currency | Country | Default Network |
|---|---|---|
| 🇰🇪 KES | Kenya | Safaricom (M-Pesa) |
| 🇹🇿 TZS | Tanzania | Airtel |
| 🇺🇬 UGX | Uganda | MTN |
| 🇷🇼 RWF | Rwanda | MTN |
| 🇿🇲 ZMW | Zambia | Airtel |
| XAF | Cameroon | Orange |
| XOF | Côte d'Ivoire | Wave |
| 🇸🇱 SLL | Sierra Leone | Africell |

> Use \`GET /api/currencies\` to see live status and required fields for every corridor.
    `,
    contact: {
      name: 'Zeeh Africa Support',
      email: 'zeehafricah@gmail.com',
      url: 'https://zeehfi.ca',
    },
  },
  servers: [
    { url: 'https://api.zeehfi.ca', description: 'Production' },
    { url: 'http://localhost:3000', description: 'Local development' },
  ],
  security: [{ ApiKeyAuth: [] }],

  tags: [
    { name: 'Currencies', description: 'Supported payout corridors and required fields per currency' },
    { name: 'Rates',     description: 'Live exchange rates and conversion calculator' },
    { name: 'Transfers', description: 'Send money to a bank account or mobile wallet' },
    { name: 'Swaps',     description: 'Convert between your wallets' },
    { name: 'Wallets',   description: 'Balances, deposit instructions (on-ramp), and transaction history' },
    { name: 'Banks',     description: 'Bank lookup and account validation' },
    { name: 'Account',   description: 'Your account details and settings' },
    { name: 'Webhooks',         description: 'Receive payment event notifications' },
    { name: 'Virtual Accounts', description: 'Assign unique deposit references to your end-customers so inbound payments are matched and credited automatically' },
    { name: 'System',           description: 'Service health' },
  ],

  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'API key obtained from Zeeh Africa. Contact zeehafricah@gmail.com.',
      },
    },
    schemas: {

      // ── Error ──────────────────────────────────────────────────
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Invalid or missing API key' },
        },
      },
      ValidationError: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Validation error' },
          errors: {
            type: 'object',
            properties: {
              fieldErrors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
      RateLimitError: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Too many requests, please try again in 60 seconds.' },
        },
      },

      // ── Rates ──────────────────────────────────────────────────
      RateQuote: {
        type: 'object',
        properties: {
          from_currency: { type: 'string', example: 'CAD' },
          to_currency:   { type: 'string', example: 'NGN' },
          rate:          { type: 'number', example: 1267.5, description: 'How many units of to_currency per 1 unit of from_currency' },
          inverse_rate:  { type: 'number', example: 0.000789, description: 'Reverse rate (to_currency → from_currency)' },
          updated_at:    { type: 'string', format: 'date-time', example: '2026-05-26T08:00:00.000Z' },
        },
      },

      // ── Wallets ────────────────────────────────────────────────
      Wallet: {
        type: 'object',
        properties: {
          wallet_id:  { type: 'string', example: '2746' },
          currency:   { type: 'string', example: 'CAD' },
          balance:    { type: 'string', example: '4749.10' },
          available:  { type: 'string', example: '4749.10' },
          pending:    { type: 'string', example: '0.00' },
          status:     { type: 'string', example: 'active' },
        },
      },

      // ── Transfers ──────────────────────────────────────────────
      Transfer: {
        type: 'object',
        properties: {
          transfer_id:       { type: 'string', example: '2332' },
          status:            { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'], example: 'processing' },
          amount:            { type: 'string', example: '50000.00' },
          currency:          { type: 'string', example: 'NGN' },
          client_reference:  { type: 'string', example: 'TRF-001' },
          description:       { type: 'string', example: 'Payout' },
          recipient: {
            type: 'object',
            properties: {
              account_name:   { type: 'string', example: 'John Doe' },
              account_number: { type: 'string', example: '0123456789' },
              bank_name:      { type: 'string', example: 'ACCESS BANK' },
            },
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },

      // ── Swaps ──────────────────────────────────────────────────
      Swap: {
        type: 'object',
        properties: {
          swap_id:       { type: 'string', example: '881' },
          status:        { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'], example: 'completed' },
          from_currency: { type: 'string', example: 'CAD' },
          to_currency:   { type: 'string', example: 'NGN' },
          from_amount:   { type: 'string', example: '1000.00' },
          to_amount:     { type: 'string', example: '1267500.00' },
          rate:          { type: 'number', example: 1267.5 },
          reference:     { type: 'string', example: 'SWAP-001' },
          created_at:    { type: 'string', format: 'date-time' },
        },
      },

      // ── Banks ──────────────────────────────────────────────────
      Bank: {
        type: 'object',
        properties: {
          id:        { type: 'integer', example: 10 },
          name:      { type: 'string', example: 'ACCESS BANK' },
          code:      { type: 'string', example: '044' },
          currency:  { type: 'string', example: 'NGN' },
        },
      },

      // ── Virtual Accounts ──────────────────────────────────────
      VirtualAccount: {
        type: 'object',
        properties: {
          account_id:     { type: 'string', example: 'VA-4F8B2C1A', description: 'Unique identifier for this virtual account' },
          customer_id:    { type: 'string', example: 'CUST-001',    description: 'Your own internal customer reference' },
          customer_name:  { type: 'string', example: 'John Doe' },
          currency:       { type: 'string', example: 'CAD' },
          reference_code: { type: 'string', example: 'ZVA-4F8B2C', description: 'The unique code your customer MUST include in their payment reference/description' },
          status:         { type: 'string', enum: ['active', 'inactive'], example: 'active' },
          total_credited: { type: 'string', example: '500.00', description: 'Running total of all deposits matched to this account' },
          created_at:     { type: 'string', format: 'date-time' },
        },
      },
      DepositInstructions: {
        type: 'object',
        properties: {
          currency:       { type: 'string', example: 'CAD' },
          method:         { type: 'string', example: 'Interac eTransfer' },
          bank_name:      { type: 'string', example: 'Interac' },
          account_name:   { type: 'string', example: 'Zeeh Africa' },
          account_number: { type: 'string', example: '9900002060' },
          send_to_email:  { type: 'string', example: 'payments@zeehfi.ca', description: 'CAD Interac eTransfer only' },
          iban:           { type: 'string', example: 'DE89370400440532012060', description: 'EUR only' },
          reference_code: { type: 'string', example: 'ZVA-4F8B2C', description: 'MUST be included in the payment reference' },
          instructions:   { type: 'string', example: 'Include exactly "ZVA-4F8B2C" as the payment reference/description.' },
        },
      },

      // ── Pagination ─────────────────────────────────────────────
      Pagination: {
        type: 'object',
        properties: {
          total:       { type: 'integer', example: 42 },
          page:        { type: 'integer', example: 1 },
          page_size:   { type: 'integer', example: 20 },
          total_pages: { type: 'integer', example: 3 },
        },
      },
    },

    // ── Reusable parameters ──────────────────────────────────────
    parameters: {
      PageParam: {
        name: 'page', in: 'query',
        description: 'Page number (starts at 1)',
        schema: { type: 'integer', default: 1, minimum: 1 },
      },
      PageSizeParam: {
        name: 'page_size', in: 'query',
        description: 'Results per page',
        schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
      },
    },

    // ── Reusable responses ───────────────────────────────────────
    responses: {
      Unauthorized: {
        description: 'Invalid or missing API key',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      RateLimited: {
        description: 'Too many requests',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/RateLimitError' } } },
      },
      NotFound: {
        description: 'Resource not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example: { success: false, message: 'Not found' } } },
      },
    },
  },

  paths: {

    // ── SYSTEM ────────────────────────────────────────────────────
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        description: 'Returns `ok` if the service is running. No API key required.',
        security: [],
        responses: {
          200: {
            description: 'Service healthy',
            content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } } } },
          },
        },
      },
    },

    // ── CURRENCIES ───────────────────────────────────────────────
    '/api/currencies': {
      get: {
        tags: ['Currencies'],
        summary: 'List all supported payout currencies',
        description: `Returns every currency Zeeh supports for outbound payouts, with live status and the exact request fields required for each one.

Use this endpoint to:
- Discover available corridors before building your payout flow
- Show only active currencies in your UI
- Get the \`payout_fields\` required for each currency's transfer request

**Status values:**
| Status | Meaning |
|---|---|
| \`active\` | Live and available for payouts |
| \`contact_support\` | Available — contact zeehafricah@gmail.com to activate |
| \`coming_soon\` | In progress, not yet live |`,
        responses: {
          200: {
            description: 'List of supported currencies with payout status',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    currencies: [
                      {
                        currency: 'NGN',
                        name: 'Nigerian Naira',
                        flag: '🇳🇬',
                        payout_status: 'active',
                        payout_method: 'Bank Transfer',
                        payout_fields: ['bank_id', 'account_number', 'account_name'],
                      },
                      {
                        currency: 'CAD',
                        name: 'Canadian Dollar',
                        flag: '🇨🇦',
                        payout_status: 'active',
                        payout_method: 'Interac eTransfer',
                        payout_fields: ['recipient_email'],
                      },
                      {
                        currency: 'KES',
                        name: 'Kenyan Shilling',
                        flag: '🇰🇪',
                        payout_status: 'active',
                        payout_method: 'Mobile Money (Safaricom)',
                        payout_fields: ['msisdn', 'recipient_first_name', 'recipient_last_name'],
                        notes: 'msisdn must include country code, e.g. 254712345678',
                      },
                      {
                        currency: 'ZAR',
                        name: 'South African Rand',
                        flag: '🇿🇦',
                        payout_status: 'active',
                        payout_method: 'Bank Transfer',
                        payout_fields: ['account_number', 'account_bank', 'recipient_first_name', 'recipient_last_name', 'recipient_email', 'recipient_phone', 'recipient_address', 'recipient_city', 'recipient_postal_code'],
                        notes: 'South Africa requires additional compliance fields',
                      },
                      {
                        currency: 'GBP',
                        name: 'British Pound',
                        flag: '🇬🇧',
                        payout_status: 'contact_support',
                        payout_method: 'Faster Payments',
                        payout_fields: [],
                      },
                    ],
                    count: 18,
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    // ── RATES ─────────────────────────────────────────────────────
    '/api/rates': {
      get: {
        tags: ['Rates'],
        summary: 'List all exchange rates',
        description: 'Returns live rates for all supported currency pairs.',
        responses: {
          200: {
            description: 'All live rates',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: {
                      type: 'object',
                      properties: {
                        rates:     { type: 'array', items: { $ref: '#/components/schemas/RateQuote' } },
                        count:     { type: 'integer', example: 8 },
                        timestamp: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
                example: {
                  success: true,
                  data: {
                    rates: [
                      { from_currency: 'CAD', to_currency: 'NGN', rate: 1267.5,  inverse_rate: 0.000789, updated_at: '2026-05-26T08:00:00.000Z' },
                      { from_currency: 'CAD', to_currency: 'USD', rate: 0.732,   inverse_rate: 1.366,    updated_at: '2026-05-26T08:00:00.000Z' },
                      { from_currency: 'USD', to_currency: 'NGN', rate: 1590.0,  inverse_rate: 0.000629, updated_at: '2026-05-26T08:00:00.000Z' },
                    ],
                    count: 8,
                    timestamp: '2026-05-26T08:00:00.000Z',
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },

    '/api/rates/convert': {
      get: {
        tags: ['Rates'],
        summary: 'Convert an amount',
        description: 'Preview exactly how much the recipient will receive for a given send amount. Use this before initiating a transfer or swap.',
        parameters: [
          { name: 'amount',        in: 'query', required: true,  schema: { type: 'number', example: 500 },      description: 'Amount to send' },
          { name: 'from_currency', in: 'query', required: true,  schema: { type: 'string', example: 'CAD' },    description: 'Currency you are sending' },
          { name: 'to_currency',   in: 'query', required: true,  schema: { type: 'string', example: 'NGN' },    description: 'Currency the recipient receives' },
        ],
        responses: {
          200: {
            description: 'Conversion breakdown',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        from_currency: { type: 'string', example: 'CAD' },
                        to_currency:   { type: 'string', example: 'NGN' },
                        from_amount:   { type: 'number', example: 500 },
                        to_amount:     { type: 'number', example: 633750 },
                        rate:          { type: 'number', example: 1267.5 },
                        updated_at:    { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
                example: {
                  success: true,
                  data: {
                    from_currency: 'CAD', to_currency: 'NGN',
                    from_amount: 500, to_amount: 633750,
                    rate: 1267.5, updated_at: '2026-05-26T08:00:00.000Z',
                  },
                },
              },
            },
          },
          400: { description: 'Invalid parameters', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },

    '/api/rates/{from_currency}/{to_currency}': {
      get: {
        tags: ['Rates'],
        summary: 'Get rate for a specific pair',
        parameters: [
          { name: 'from_currency', in: 'path', required: true, schema: { type: 'string', example: 'CAD' }, description: 'Source currency (3-letter ISO code)' },
          { name: 'to_currency',   in: 'path', required: true, schema: { type: 'string', example: 'NGN' }, description: 'Target currency (3-letter ISO code)' },
        ],
        responses: {
          200: {
            description: 'Rate for the requested pair',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    from_currency: 'CAD', to_currency: 'NGN',
                    rate: 1267.5, inverse_rate: 0.000789,
                    updated_at: '2026-05-26T08:00:00.000Z',
                    timestamp:  '2026-05-26T08:00:00.000Z',
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },

    // ── TRANSFERS ─────────────────────────────────────────────────
    '/api/transfers': {
      post: {
        tags: ['Transfers'],
        summary: 'Send money',
        description: `Initiate a payout to a recipient's bank account or mobile money wallet.

**Required fields by currency:**

| Currency | Method | Required fields |
|---|---|---|
| 🇳🇬 NGN | Bank transfer | \`bank_id\`, \`account_number\`, \`account_name\` |
| 🇨🇦 CAD | Interac eTransfer | \`recipient_email\` |
| 🇺🇸 USD | Wire / ACH | \`account_number\`, \`bank_name\`, \`routing_number\`, \`email\`, \`account_type\` |
| 🇬🇭 GHS | Bank transfer | \`account_number\`, \`account_bank\`, \`recipient_first_name\`, \`recipient_last_name\` |
| 🇿🇦 ZAR | Bank transfer | \`account_number\`, \`account_bank\`, \`recipient_first_name\`, \`recipient_last_name\`, \`recipient_email\`, \`recipient_phone\`, \`recipient_address\`, \`recipient_city\`, \`recipient_postal_code\` |
| 🇪🇬 EGP | Bank transfer | \`account_number\`, \`account_bank\`, \`recipient_first_name\`, \`recipient_last_name\` |
| 🇪🇹 ETB | Bank transfer | \`account_number\`, \`account_bank\`, \`recipient_first_name\`, \`recipient_last_name\` |
| 🇲🇼 MWK | Bank transfer | \`account_number\`, \`account_bank\`, \`recipient_first_name\`, \`recipient_last_name\` |
| 🇰🇪 KES | Mobile money | \`msisdn\` (phone with country code), optional \`mobile_network\` |
| 🇹🇿 TZS | Mobile money | \`msisdn\`, optional \`mobile_network\` |
| 🇺🇬 UGX | Mobile money | \`msisdn\`, optional \`mobile_network\` |
| 🇷🇼 RWF | Mobile money | \`msisdn\`, optional \`mobile_network\` |
| 🇿🇲 ZMW | Mobile money | \`msisdn\`, optional \`mobile_network\` |
| XAF | Mobile money | \`msisdn\`, optional \`mobile_network\` |
| XOF | Mobile money | \`msisdn\`, optional \`mobile_network\` |
| 🇸🇱 SLL | Mobile money | \`msisdn\`, optional \`mobile_network\` |
| 🇬🇧 GBP / 🇪🇺 EUR | — | Contact support |

> **Tip:** Use \`GET /api/currencies\` to see live status and required fields per corridor.
> Use \`GET /api/account/banks\` for the \`bank_id\` for NGN and \`account_bank\` codes for African bank transfers.
> Use \`POST /api/account/banks/validate\` to verify an account before sending.`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount', 'currency', 'client_reference'],
                properties: {
                  amount:           { type: 'string', example: '50000.00', description: 'Amount as a decimal string' },
                  currency: {
                    type: 'string',
                    enum: ['NGN','CAD','USD','GBP','EUR','GHS','ZAR','EGP','ETB','MWK','KES','TZS','UGX','RWF','ZMW','XAF','XOF','SLL'],
                    example: 'NGN',
                    description: '3-letter ISO currency code. Use GET /api/currencies to see full list with live status.',
                  },
                  client_reference: { type: 'string', example: 'TRF-001', description: 'Your unique reference — used for idempotency and tracking' },
                  description:      { type: 'string', example: 'Salary payment' },
                  reference:        { type: 'string', example: 'INV-2026-001' },
                  // ── NGN ───────────────────────────────────────────
                  bank_id:          { type: 'integer', example: 10, description: '🇳🇬 NGN — bank ID from GET /api/account/banks' },
                  account_number:   { type: 'string', example: '0123456789', description: '🇳🇬 NGN / 🇺🇸 USD / African bank transfers' },
                  account_name:     { type: 'string', example: 'John Doe', description: '🇳🇬 NGN' },
                  // ── CAD ───────────────────────────────────────────
                  recipient_email:  { type: 'string', format: 'email', example: 'jane@example.com', description: '🇨🇦 CAD — Interac eTransfer email. Also required for 🇿🇦 ZAR.' },
                  // ── USD ───────────────────────────────────────────
                  bank_name:        { type: 'string', example: 'Chase Bank', description: '🇺🇸 USD' },
                  routing_number:   { type: 'string', example: '021000021', description: '🇺🇸 USD — 9-digit routing number' },
                  email:            { type: 'string', format: 'email', example: 'john@example.com', description: '🇺🇸 USD' },
                  account_type:     { type: 'string', enum: ['checking', 'savings'], description: '🇺🇸 USD' },
                  // ── African bank transfers (GHS, ZAR, EGP, ETB, MWK) ──
                  account_bank:         { type: 'string', example: '044', description: 'African bank transfers — bank code (e.g. "044" for Access Bank GH). Use GET /api/account/banks?currency=GHS for codes.' },
                  recipient_first_name: { type: 'string', example: 'Amara', description: 'African bank transfers — recipient first name' },
                  recipient_last_name:  { type: 'string', example: 'Mensah', description: 'African bank transfers — recipient last name' },
                  // ── ZAR compliance extras ─────────────────────────
                  recipient_phone:        { type: 'string', example: '821234567', description: '🇿🇦 ZAR only — recipient phone (without country code)' },
                  recipient_address:      { type: 'string', example: '12 Long Street', description: '🇿🇦 ZAR only — street address' },
                  recipient_city:         { type: 'string', example: 'Cape Town', description: '🇿🇦 ZAR only' },
                  recipient_country:      { type: 'string', example: 'ZA', description: '🇿🇦 ZAR only — ISO-3166 alpha-2, defaults to ZA' },
                  recipient_postal_code:  { type: 'string', example: '8001', description: '🇿🇦 ZAR only' },
                  // ── Mobile money (KES, TZS, UGX, RWF, ZMW, XAF, XOF, SLL) ──
                  msisdn:         { type: 'string', example: '254712345678', description: 'Mobile money — recipient phone with country code (e.g. 254 for Kenya, 255 for Tanzania)' },
                  mobile_network: { type: 'string', example: 'Safaricom', description: 'Mobile money — override default network. Defaults: KES→Safaricom, TZS→Airtel, UGX→MTN, RWF→MTN, ZMW→Airtel, XAF→Orange, XOF→Wave, SLL→Africell' },
                  // ── Reconciliation ────────────────────────────────
                  virtual_account_id: { type: 'string', example: 'VA-4F8B2C1A', description: 'Optional. Tag this transfer to one of your virtual accounts. Stored in the ledger transaction — lets you reconcile payouts against which customer/virtual account they came from. Use GET /api/balance/transactions/history to query.' },
                },
              },
              examples: {
                NGN: {
                  summary: '🇳🇬 NGN bank transfer',
                  value: { currency: 'NGN', amount: '50000.00', bank_id: 10, account_number: '0123456789', account_name: 'John Doe', description: 'Salary payment', client_reference: 'TRF-001' },
                },
                CAD: {
                  summary: '🇨🇦 CAD Interac eTransfer',
                  value: { currency: 'CAD', amount: '250.00', recipient_email: 'jane@example.com', description: 'Freelance payout', client_reference: 'TRF-002' },
                },
                USD: {
                  summary: '🇺🇸 USD wire transfer',
                  value: { currency: 'USD', amount: '1000.00', account_number: '123456789', account_name: 'John Doe', bank_name: 'Chase Bank', routing_number: '021000021', email: 'john@example.com', account_type: 'checking', client_reference: 'TRF-003' },
                },
                GHS: {
                  summary: '🇬🇭 GHS Ghana bank transfer',
                  value: { currency: 'GHS', amount: '500.00', account_number: '0123456789', account_bank: '044', recipient_first_name: 'Amara', recipient_last_name: 'Mensah', description: 'Payout', client_reference: 'TRF-004' },
                },
                KES: {
                  summary: '🇰🇪 KES Kenya mobile money (M-Pesa)',
                  value: { currency: 'KES', amount: '2000.00', msisdn: '254712345678', recipient_first_name: 'James', recipient_last_name: 'Kamau', description: 'Mobile payout', client_reference: 'TRF-005' },
                },
                ZAR: {
                  summary: '🇿🇦 ZAR South Africa bank transfer',
                  value: { currency: 'ZAR', amount: '1500.00', account_number: '62834567891', account_bank: 'FNBZAJJ', recipient_first_name: 'Thabo', recipient_last_name: 'Nkosi', recipient_email: 'thabo@example.com', recipient_phone: '821234567', recipient_address: '12 Long Street', recipient_city: 'Cape Town', recipient_postal_code: '8001', description: 'Payout', client_reference: 'TRF-006' },
                },
                XOF: {
                  summary: 'XOF Côte d\'Ivoire mobile money (Wave)',
                  value: { currency: 'XOF', amount: '50000.00', msisdn: '2250701234567', recipient_first_name: 'Kofi', recipient_last_name: 'Asante', description: 'Mobile payout', client_reference: 'TRF-007' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Transfer initiated successfully',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    transfer: {
                      transfer_id: '2332', status: 'processing',
                      amount: '50000.00', currency: 'NGN',
                      client_reference: 'TRF-001',
                      recipient: { account_name: 'John Doe', account_number: '0123456789', bank_name: 'ACCESS BANK' },
                      created_at: '2026-05-26T08:05:00.000Z',
                    },
                  },
                },
              },
            },
          },
          400: { description: 'Validation error — check required fields for the currency', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },

    '/api/transfers/list': {
      get: {
        tags: ['Transfers'],
        summary: 'List transfers',
        description: 'Returns a paginated list of all transfers. Filter by currency or status.',
        parameters: [
          { name: 'currency', in: 'query', schema: { type: 'string', example: 'NGN' }, description: 'Filter by currency' },
          { name: 'status',   in: 'query', schema: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] }, description: 'Filter by status' },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/PageSizeParam' },
        ],
        responses: {
          200: {
            description: 'Paginated transfer list',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    transfers: [
                      { transfer_id: '2332', status: 'completed', amount: '50000.00', currency: 'NGN', client_reference: 'TRF-001', created_at: '2026-05-26T08:05:00.000Z' },
                      { transfer_id: '2331', status: 'completed', amount: '250.00',   currency: 'CAD', client_reference: 'TRF-002', created_at: '2026-05-25T14:30:00.000Z' },
                    ],
                    pagination: { total: 42, page: 1, page_size: 20, total_pages: 3 },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/transfers/verification': {
      get: {
        tags: ['Transfers'],
        summary: 'Look up transfer by your reference',
        description: 'Find a transfer using the `client_reference` you provided when creating it. Useful for checking status without storing our transfer ID.',
        parameters: [
          { name: 'reference', in: 'query', required: true, schema: { type: 'string', example: 'TRF-001' }, description: 'The client_reference you provided when creating the transfer' },
        ],
        responses: {
          200: {
            description: 'Transfer found',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    transfer: { transfer_id: '2332', status: 'completed', amount: '50000.00', currency: 'NGN', client_reference: 'TRF-001' },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/api/transfers/{transfer_id}': {
      get: {
        tags: ['Transfers'],
        summary: 'Get transfer by ID',
        parameters: [
          { name: 'transfer_id', in: 'path', required: true, schema: { type: 'string', example: '2332' }, description: 'Transfer ID returned when the transfer was created' },
        ],
        responses: {
          200: {
            description: 'Transfer details',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    transfer: {
                      transfer_id: '2332', status: 'completed',
                      amount: '50000.00', currency: 'NGN',
                      client_reference: 'TRF-001', description: 'Salary payment',
                      recipient: { account_name: 'John Doe', account_number: '0123456789', bank_name: 'ACCESS BANK' },
                      created_at: '2026-05-26T08:05:00.000Z', updated_at: '2026-05-26T08:07:32.000Z',
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    // ── SWAPS ─────────────────────────────────────────────────────
    '/api/swaps': {
      post: {
        tags: ['Swaps'],
        summary: 'Execute a currency swap',
        description: `Convert funds from one of your wallets to another at the live rate.

Use \`GET /api/wallets\` to find your wallet IDs, and \`GET /api/rates/convert\` to preview the amount before executing.`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['from_wallet_id', 'to_wallet_id', 'amount', 'from_currency', 'to_currency'],
                properties: {
                  from_wallet_id: { type: 'string', example: '2746', description: 'Wallet to debit — use GET /api/wallets to find IDs' },
                  to_wallet_id:   { type: 'string', example: '2748', description: 'Wallet to credit' },
                  amount:         { type: 'string', example: '1000.00', description: 'Amount to convert (in from_currency)' },
                  from_currency:  { type: 'string', example: 'CAD' },
                  to_currency:    { type: 'string', example: 'NGN' },
                  lock_rate:      { type: 'boolean', default: false, description: 'Lock the rate at quote time' },
                  reference:      { type: 'string', example: 'SWAP-001' },
                },
              },
              example: {
                from_wallet_id: '2746', to_wallet_id: '2748',
                amount: '1000.00', from_currency: 'CAD', to_currency: 'NGN',
                reference: 'SWAP-001',
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Swap executed',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    swap: { swap_id: '881', status: 'completed' },
                    settlement: {
                      from_amount: 1000, from_currency: 'CAD',
                      to_amount: 1267500, to_currency: 'NGN',
                      rate: 1267.5,
                    },
                  },
                },
              },
            },
          },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },

    '/api/swaps/list': {
      get: {
        tags: ['Swaps'],
        summary: 'List swaps',
        parameters: [
          { name: 'currency', in: 'query', schema: { type: 'string', example: 'CAD' }, description: 'Filter by source currency' },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/PageSizeParam' },
        ],
        responses: {
          200: {
            description: 'Paginated swap list',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    swaps: [
                      { swap_id: '881', status: 'completed', from_currency: 'CAD', to_currency: 'NGN', from_amount: '1000.00', to_amount: '1267500.00', rate: 1267.5, created_at: '2026-05-26T08:00:00.000Z' },
                    ],
                    pagination: { total: 5, page: 1, page_size: 20, total_pages: 1 },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/swaps/{swap_id}': {
      get: {
        tags: ['Swaps'],
        summary: 'Get swap by ID',
        parameters: [
          { name: 'swap_id', in: 'path', required: true, schema: { type: 'string', example: '881' }, description: 'Swap ID returned when the swap was created' },
        ],
        responses: {
          200: {
            description: 'Swap details',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    swap: { swap_id: '881', status: 'completed', from_currency: 'CAD', to_currency: 'NGN', from_amount: '1000.00', to_amount: '1267500.00', rate: 1267.5, reference: 'SWAP-001', created_at: '2026-05-26T08:00:00.000Z' },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    // ── WALLETS ───────────────────────────────────────────────────
    '/api/wallets/deposit': {
      get: {
        tags: ['Wallets'],
        summary: 'Get deposit instructions (on-ramp)',
        description: `Returns the virtual bank account details for every currency. Send funds to these accounts to top up your wallet.

Each currency has its own dedicated account — funds credited automatically upon receipt:

| Currency | Method |
|---|---|
| 🇨🇦 CAD | Interac eTransfer |
| 🇳🇬 NGN | Bank Transfer |
| 🇬🇧 GBP | Faster Payments (FPS) |
| 🇪🇺 EUR | SEPA Transfer |
| 🇺🇸 USD | Wire / ACH |`,
        responses: {
          200: {
            description: 'Deposit instructions for all currencies',
            content: {
              'application/json': {
                example: {
                  success: true,
                  message: 'Send funds to any of these accounts to top up your wallet.',
                  data: {
                    deposit_accounts: [
                      {
                        currency: 'CAD', method: 'Interac eTransfer',
                        bank_name: 'Interac', account_name: 'Zeeh Africa',
                        send_to_email: 'payments@zeehfi.ca',
                        ddt_number: 'DDT-002060',
                        instructions: 'Send an Interac eTransfer to the email above. Funds settle within minutes.',
                        verified: true,
                      },
                      {
                        currency: 'NGN', method: 'Bank Transfer',
                        bank_name: 'Naira Virtual Bank', account_name: 'Zeeh Africa',
                        account_number: '9900002060',
                        instructions: 'Transfer to the account number above via any Nigerian bank or mobile app.',
                        verified: true,
                      },
                      {
                        currency: 'GBP', method: 'Faster Payments (FPS)',
                        bank_name: 'FPS Gateway', account_name: 'Zeeh Africa',
                        account_number: '8800002060',
                        instructions: 'Send a Faster Payments transfer to the account number above.',
                        verified: true,
                      },
                      {
                        currency: 'EUR', method: 'SEPA Transfer',
                        bank_name: 'SEPA Gateway', account_name: 'Zeeh Africa',
                        iban: 'DE89370400440532012060',
                        instructions: 'Send a SEPA transfer to the IBAN above.',
                        verified: true,
                      },
                      {
                        currency: 'USD', method: 'Wire Transfer (ACH)',
                        bank_name: 'Wire Gateway', account_name: 'Zeeh Africa',
                        account_number: '440000002060',
                        instructions: 'Send a domestic wire or ACH transfer to the account number above.',
                        verified: true,
                      },
                    ],
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/wallets/deposit/{currency}': {
      get: {
        tags: ['Wallets'],
        summary: 'Get deposit instructions for one currency',
        parameters: [
          { name: 'currency', in: 'path', required: true, schema: { type: 'string', example: 'CAD' }, description: '3-letter currency code' },
        ],
        responses: {
          200: {
            description: 'Deposit instructions for the requested currency',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    deposit_account: {
                      currency: 'CAD', method: 'Interac eTransfer',
                      bank_name: 'Interac', account_name: 'Zeeh Africa',
                      send_to_email: 'payments@zeehfi.ca',
                      ddt_number: 'DDT-002060',
                      instructions: 'Send an Interac eTransfer to the email above. Funds settle within minutes.',
                      verified: true,
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'No wallet found for this currency' },
        },
      },
    },

    '/api/wallets': {
      get: {
        tags: ['Wallets'],
        summary: 'List all wallets',
        description: 'Returns all your active currency wallets with balances.',
        responses: {
          200: {
            description: 'Wallet list',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    wallets: [
                      { wallet_id: '2746', currency: 'CAD', balance: '4749.10', available: '4749.10', pending: '0.00', status: 'active' },
                      { wallet_id: '2747', currency: 'USD', balance: '2100.00', available: '2100.00', pending: '0.00', status: 'active' },
                      { wallet_id: '2748', currency: 'NGN', balance: '4500000.00', available: '4500000.00', pending: '0.00', status: 'active' },
                    ],
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/wallets/balances': {
      get: {
        tags: ['Wallets'],
        summary: 'Quick balance summary',
        description: 'Returns available, pending, and total balance for all currencies in a single lightweight call.',
        responses: {
          200: {
            description: 'All balances',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    balances: [
                      { currency: 'CAD', balance: '4749.10', available: '4749.10', pending: '0.00' },
                      { currency: 'USD', balance: '2100.00', available: '2100.00', pending: '0.00' },
                      { currency: 'NGN', balance: '4500000.00', available: '4500000.00', pending: '0.00' },
                    ],
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/wallets/{currency}': {
      get: {
        tags: ['Wallets'],
        summary: 'Get wallet by currency',
        parameters: [
          { name: 'currency', in: 'path', required: true, schema: { type: 'string', example: 'CAD' }, description: '3-letter currency code' },
        ],
        responses: {
          200: {
            description: 'Wallet details',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    wallet: { wallet_id: '2746', currency: 'CAD', balance: '4749.10', available: '4749.10', pending: '0.00', status: 'active' },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/api/wallets/{currency}/transactions': {
      get: {
        tags: ['Wallets'],
        summary: 'Wallet transaction history',
        description: 'All credits and debits for a specific currency wallet.',
        parameters: [
          { name: 'currency', in: 'path', required: true, schema: { type: 'string', example: 'CAD' }, description: '3-letter currency code' },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/PageSizeParam' },
        ],
        responses: {
          200: {
            description: 'Transaction history',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    transactions: [
                      { id: 'txn_001', type: 'debit',  amount: '1000.00', currency: 'CAD', description: 'Swap to NGN',       balance_after: '3749.10', created_at: '2026-05-26T08:00:00.000Z' },
                      { id: 'txn_002', type: 'credit', amount: '5000.00', currency: 'CAD', description: 'Wallet funding',   balance_after: '4749.10', created_at: '2026-05-25T10:00:00.000Z' },
                    ],
                    pagination: { total: 24, page: 1, page_size: 20, total_pages: 2 },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    // ── BANKS ─────────────────────────────────────────────────────
    '/api/account/banks': {
      get: {
        tags: ['Banks'],
        summary: 'List supported banks',
        description: 'Returns all supported banks for a given currency. Use the `id` field as `bank_id` when initiating NGN transfers.',
        parameters: [
          { name: 'currency', in: 'query', required: true, schema: { type: 'string', enum: ['NGN', 'CAD', 'USD', 'GBP', 'EUR'], example: 'NGN' }, description: 'Currency to list banks for' },
        ],
        responses: {
          200: {
            description: 'List of banks',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    banks: [
                      { id: 10,  name: 'ACCESS BANK',             code: '044', currency: 'NGN' },
                      { id: 20,  name: 'FIRST BANK OF NIGERIA',   code: '011', currency: 'NGN' },
                      { id: 30,  name: 'GUARANTY TRUST BANK',     code: '058', currency: 'NGN' },
                      { id: 40,  name: 'UNITED BANK FOR AFRICA',  code: '033', currency: 'NGN' },
                      { id: 50,  name: 'ZENITH BANK',             code: '057', currency: 'NGN' },
                    ],
                  },
                },
              },
            },
          },
          400: { description: 'Missing or invalid currency', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/account/banks/validate': {
      post: {
        tags: ['Banks'],
        summary: 'Validate a bank account',
        description: `Verify an account number before sending money. Returns the registered account holder name if valid.

> **Best practice:** Always validate before initiating a transfer to avoid failed payments.`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currency', 'account_number'],
                properties: {
                  currency:       { type: 'string', enum: ['NGN', 'CAD', 'USD'], example: 'NGN' },
                  bank_code:      { type: 'string', example: '044', description: '🇳🇬 NGN only — bank code from GET /api/account/banks' },
                  account_number: { type: 'string', example: '0123456789' },
                },
              },
              examples: {
                NGN: { summary: '🇳🇬 NGN bank account', value: { currency: 'NGN', bank_code: '044', account_number: '0123456789' } },
                CAD: { summary: '🇨🇦 CAD Interac email', value: { currency: 'CAD', account_number: 'jane@example.com' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Account is valid',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    valid: true,
                    account_name:   'JOHN DOE',
                    account_number: '0123456789',
                    bank: { id: 10, name: 'ACCESS BANK', code: '044' },
                  },
                },
              },
            },
          },
          400: { description: 'Invalid account number or bank code', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    // ── ACCOUNT ───────────────────────────────────────────────────
    '/api/account': {
      get: {
        tags: ['Account'],
        summary: 'Get account details',
        description: 'Returns your company profile, KYB verification status, and settings.',
        responses: {
          200: {
            description: 'Account details',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    account: {
                      account_id:     'acc_001',
                      company_name:   'Zeeh Africa',
                      email:          'zeehafricah@gmail.com',
                      kyb_status:     'approved',
                      webhook_url:    'https://api.zeehfi.ca/webhooks/receive',
                      created_at:     '2026-01-01T00:00:00.000Z',
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
      patch: {
        tags: ['Account'],
        summary: 'Update account settings',
        description: 'Update your webhook URL or contact information. Only fields you provide will be changed.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  contact_email: { type: 'string', format: 'email', example: 'payments@yourcompany.com' },
                  contact_phone: { type: 'string', example: '+14165559999' },
                  webhook_url:   { type: 'string', format: 'uri', example: 'https://yourapp.com/webhooks/zeeh' },
                },
              },
              example: { webhook_url: 'https://yourapp.com/webhooks/zeeh' },
            },
          },
        },
        responses: {
          200: {
            description: 'Account updated',
            content: { 'application/json': { example: { success: true, message: 'Account updated successfully' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/account/transactions': {
      get: {
        tags: ['Account'],
        summary: 'Full transaction history',
        description: 'Unified view of all transfers, swaps, and wallet funding across all currencies and wallets.',
        parameters: [
          { name: 'currency', in: 'query', schema: { type: 'string', example: 'NGN' }, description: 'Filter by currency' },
          { name: 'type',     in: 'query', schema: { type: 'string', enum: ['transfer', 'swap', 'wallet_funding'] }, description: 'Filter by transaction type' },
          { name: 'status',   in: 'query', schema: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] } },
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/PageSizeParam' },
        ],
        responses: {
          200: {
            description: 'Transaction history',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    transactions: [
                      { id: 'txn_201', type: 'transfer', status: 'completed', amount: '50000.00', currency: 'NGN', description: 'Salary payment', created_at: '2026-05-26T08:05:00.000Z' },
                      { id: 'txn_200', type: 'swap',     status: 'completed', amount: '1000.00',  currency: 'CAD', description: 'CAD → NGN swap', created_at: '2026-05-26T08:00:00.000Z' },
                    ],
                    pagination: { total: 87, page: 1, page_size: 20, total_pages: 5 },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    // ── WEBHOOKS ──────────────────────────────────────────────────
    '/api/webhooks': {
      post: {
        tags: ['Webhooks'],
        summary: 'Register webhook URL',
        description: 'Set the URL that will receive payment event notifications. Use `PATCH /api/account` as an alternative.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url:         { type: 'string', format: 'uri', example: 'https://yourapp.com/webhooks/zeeh' },
                  description: { type: 'string', example: 'Production webhook' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Webhook registered', content: { 'application/json': { example: { success: true, message: 'Webhook registered' } } } },
          400: { description: 'Invalid URL' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    // ── VIRTUAL ACCOUNTS ─────────────────────────────────────────
    '/api/virtual-accounts': {
      post: {
        tags: ['Virtual Accounts'],
        summary: 'Create a virtual account',
        description: `Generate a unique deposit reference for one of your end-customers.

**How it works:**

1. Call this endpoint for each customer — you get back a \`reference_code\` (e.g. \`ZVA-4F8B2C\`) and deposit instructions
2. Share the deposit instructions with your customer
3. Your customer sends money to Zeeh's pooled bank account and puts \`ZVA-4F8B2C\` in the payment reference/description
4. Zeeh automatically matches the incoming deposit to this virtual account and credits **your** ledger
5. A \`virtual_account.credited\` webhook fires to your endpoint

> **Important:** Instruct your customer to include the exact \`reference_code\` in the payment description. If they forget it, the deposit goes into the unmatched queue for manual assignment.`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['customer_id', 'customer_name', 'currency'],
                properties: {
                  customer_id:   { type: 'string', example: 'CUST-001',  description: 'Your internal reference for this customer — returned on every webhook so you can reconcile in your system' },
                  customer_name: { type: 'string', example: 'John Doe',  description: 'Human-readable label — appears in your dashboard and webhook payloads' },
                  currency:      { type: 'string', enum: ['CAD', 'USD', 'GBP', 'EUR', 'NGN'], example: 'CAD', description: 'Currency the customer will deposit. One virtual account per currency per customer.' },
                  description:   { type: 'string', example: 'Wallet top-up for premium tier', description: 'Optional internal note' },
                  metadata:      { type: 'object', example: { plan: 'premium', region: 'Ontario' }, description: 'Any additional key-value data you want attached to this account' },
                },
              },
              examples: {
                CAD: {
                  summary: '🇨🇦 CAD virtual account (Interac)',
                  value: { customer_id: 'CUST-001', customer_name: 'John Doe', currency: 'CAD', description: 'Wallet funding' },
                },
                NGN: {
                  summary: '🇳🇬 NGN virtual account (Bank Transfer)',
                  value: { customer_id: 'CUST-002', customer_name: 'Amara Okafor', currency: 'NGN' },
                },
                GBP: {
                  summary: '🇬🇧 GBP virtual account (Faster Payments)',
                  value: { customer_id: 'CUST-003', customer_name: 'Sophie Williams', currency: 'GBP', metadata: { tier: 'business' } },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Virtual account created — share `deposit_instructions` with your customer',
            content: {
              'application/json': {
                example: {
                  success: true,
                  message: 'Virtual account created. Share the deposit instructions with your customer.',
                  data: {
                    virtual_account: {
                      account_id:     'VA-4F8B2C1A',
                      customer_id:    'CUST-001',
                      customer_name:  'John Doe',
                      currency:       'CAD',
                      reference_code: 'ZVA-4F8B2C',
                      status:         'active',
                      total_credited: '0.00',
                      created_at:     '2026-05-28T10:00:00.000Z',
                    },
                    deposit_instructions: {
                      currency:       'CAD',
                      method:         'Interac eTransfer',
                      bank_name:      'Interac',
                      account_name:   'Zeeh Africa',
                      send_to_email:  'payments@zeehfi.ca',
                      reference_code: 'ZVA-4F8B2C',
                      instructions:   'Include exactly "ZVA-4F8B2C" as the payment reference/description. This is how we match your deposit to your account.',
                    },
                  },
                },
              },
            },
          },
          400: { description: 'Validation error — check currency and required fields', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
      get: {
        tags: ['Virtual Accounts'],
        summary: 'List virtual accounts',
        description: 'Returns all virtual accounts you have created. Filter by currency or status.',
        parameters: [
          { name: 'currency', in: 'query', schema: { type: 'string', example: 'CAD' },           description: 'Filter by currency' },
          { name: 'status',   in: 'query', schema: { type: 'string', enum: ['active','inactive'] }, description: 'Filter by status' },
          { name: 'limit',    in: 'query', schema: { type: 'integer', default: 50, maximum: 200 }, description: 'Max results to return' },
        ],
        responses: {
          200: {
            description: 'List of virtual accounts',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    virtual_accounts: [
                      { account_id: 'VA-4F8B2C1A', customer_id: 'CUST-001', customer_name: 'John Doe',      currency: 'CAD', reference_code: 'ZVA-4F8B2C', status: 'active', total_credited: '500.00', created_at: '2026-05-28T10:00:00.000Z' },
                      { account_id: 'VA-3E7A1B2C', customer_id: 'CUST-002', customer_name: 'Amara Okafor', currency: 'NGN', reference_code: 'ZVA-3E7A1B', status: 'active', total_credited: '0.00',   created_at: '2026-05-27T09:00:00.000Z' },
                    ],
                    count: 2,
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/api/virtual-accounts/{account_id}': {
      get: {
        tags: ['Virtual Accounts'],
        summary: 'Get a virtual account',
        description: 'Returns full details including fresh deposit instructions. Share these with your customer whenever they need to make a deposit.',
        parameters: [
          { name: 'account_id', in: 'path', required: true, schema: { type: 'string', example: 'VA-4F8B2C1A' }, description: 'Virtual account ID' },
        ],
        responses: {
          200: {
            description: 'Virtual account details with deposit instructions',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    virtual_account: {
                      account_id:     'VA-4F8B2C1A',
                      customer_id:    'CUST-001',
                      customer_name:  'John Doe',
                      currency:       'CAD',
                      reference_code: 'ZVA-4F8B2C',
                      status:         'active',
                      description:    'Wallet top-up',
                      total_credited: '500.00',
                      created_at:     '2026-05-28T10:00:00.000Z',
                      updated_at:     '2026-05-28T14:30:00.000Z',
                    },
                    deposit_instructions: {
                      currency:       'CAD',
                      method:         'Interac eTransfer',
                      bank_name:      'Interac',
                      account_name:   'Zeeh Africa',
                      send_to_email:  'payments@zeehfi.ca',
                      reference_code: 'ZVA-4F8B2C',
                      instructions:   'Include exactly "ZVA-4F8B2C" as the payment reference/description.',
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
      delete: {
        tags: ['Virtual Accounts'],
        summary: 'Deactivate a virtual account',
        description: `Sets the virtual account status to \`inactive\`. Any future deposits referencing this code will **not** be auto-credited — they will go to the unmatched pending queue instead.

> This is a soft delete. The account record and its history are preserved. This action cannot be undone via API — contact support to reactivate.`,
        parameters: [
          { name: 'account_id', in: 'path', required: true, schema: { type: 'string', example: 'VA-4F8B2C1A' }, description: 'Virtual account ID to deactivate' },
        ],
        responses: {
          200: {
            description: 'Virtual account deactivated',
            content: { 'application/json': { example: { success: true, message: 'Virtual account deactivated. No further deposits will be credited to it.' } } },
          },
          400: { description: 'Account is already inactive', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/api/virtual-accounts/{account_id}/transactions': {
      get: {
        tags: ['Virtual Accounts'],
        summary: 'Transaction history for a virtual account',
        description: 'Returns all deposits that were matched and credited to this virtual account, newest first.',
        parameters: [
          { name: 'account_id', in: 'path', required: true, schema: { type: 'string', example: 'VA-4F8B2C1A' }, description: 'Virtual account ID' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 }, description: 'Max results' },
        ],
        responses: {
          200: {
            description: 'Deposit history for this virtual account',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    account_id:  'VA-4F8B2C1A',
                    customer_id: 'CUST-001',
                    currency:    'CAD',
                    transactions: [
                      { txn_id: 'txn_301', amount: '300.00', currency: 'CAD', balance_after: '500.00', description: 'Virtual account deposit — John Doe (CUST-001)', created_at: '2026-05-28T14:30:00.000Z' },
                      { txn_id: 'txn_288', amount: '200.00', currency: 'CAD', balance_after: '200.00', description: 'Virtual account deposit — John Doe (CUST-001)', created_at: '2026-05-27T10:00:00.000Z' },
                    ],
                    count: 2,
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/webhooks/receive': {
      post: {
        tags: ['Webhooks'],
        summary: 'Webhook receiver',
        security: [],
        description: `This endpoint receives real-time event notifications. **No API key required.**

Respond with **HTTP 200** within 10 seconds — failed deliveries are retried automatically.

**Event types:**

| Event | Description |
|---|---|
| \`transfer.completed\`       | Payout delivered to recipient |
| \`transfer.failed\`          | Payout failed |
| \`swap.completed\`           | Currency swap completed |
| \`wallet.funded\`            | Wallet received a deposit |
| \`virtual_account.credited\` | A virtual account deposit was matched and credited to your ledger |`,
        requestBody: {
          content: {
            'application/json': {
              examples: {
                transfer_completed: {
                  summary: 'transfer.completed',
                  value: {
                    event: 'transfer.completed',
                    data: {
                      transfer_id: '2332', status: 'completed',
                      amount: '50000.00', currency: 'NGN',
                      client_reference: 'TRF-001',
                      recipient: { bank_name: 'ACCESS BANK', account_number: '0123456789', account_name: 'JOHN DOE' },
                      completed_at: '2026-05-26T08:07:32.000Z',
                    },
                  },
                },
                swap_completed: {
                  summary: 'swap.completed',
                  value: {
                    event: 'swap.completed',
                    data: {
                      swap_id: '881', status: 'completed',
                      from_currency: 'CAD', to_currency: 'NGN',
                      from_amount: '1000.00', to_amount: '1267500.00',
                    },
                  },
                },
                virtual_account_credited: {
                  summary: 'virtual_account.credited',
                  value: {
                    event: 'virtual_account.credited',
                    data: {
                      account_id:     'VA-4F8B2C1A',
                      customer_id:    'CUST-001',
                      customer_name:  'John Doe',
                      currency:       'CAD',
                      amount:         '300.00',
                      reference_code: 'ZVA-4F8B2C',
                      total_credited: '500.00',
                      credited_at:    '2026-05-28T14:30:00.000Z',
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Event acknowledged', content: { 'application/json': { example: { received: true } } } },
        },
      },
    },
  },
};
