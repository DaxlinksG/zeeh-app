export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Zeeh Africa — Cross-Border Payments API',
    version: '1.0.0',
    description: `
## Overview
**Zeeh Africa** is a cross-border payment API enabling fast, affordable money movement between Canada, Nigeria, the US, UK, and Europe.

---

## Quick Start

1. **Get your API key** — contact us at zeehafricah@gmail.com
2. **Add the header** to every request:
\`\`\`
x-api-key: YOUR_API_KEY
\`\`\`
3. **Check live rates** → \`GET /api/rates\`
4. **Send a payment** → \`POST /api/transfers\`

---

## Authentication

All endpoints require your API key in the **\`x-api-key\`** header.

**Public endpoints (no key needed):**
- \`GET /health\`
- \`POST /webhooks/receive\`

---

## Rate Limits

| Endpoint group | Limit |
|---|---|
| Global (all endpoints) | 120 requests / minute |
| Transfers & Swaps | 20 requests / minute |
| Rate quotes | 300 requests / minute |

Exceeding the limit returns **HTTP 429**. Wait 60 seconds and retry.

---

## Supported Currencies

| Currency | Send | Receive | Method |
|---|---|---|---|
| 🇨🇦 CAD | ✅ | ✅ | Interac eTransfer |
| 🇳🇬 NGN | ✅ | ✅ | Bank transfer |
| 🇺🇸 USD | ✅ | ✅ | Wire transfer |
| 🇬🇧 GBP | ✅ | ✅ | Bank transfer |
| 🇪🇺 EUR | ✅ | ✅ | Bank transfer |
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
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'Your Zeeh Africa API key. Contact zeehafricah@gmail.com to get one.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Invalid or missing API key' },
        },
      },
      RateLimitError: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Too many requests, please try again in 60 seconds.' },
        },
      },
      RateQuote: {
        type: 'object',
        properties: {
          from_currency: { type: 'string', example: 'CAD' },
          to_currency:   { type: 'string', example: 'NGN' },
          rate:          { type: 'number', example: 1267.5 },
          inverse_rate:  { type: 'number', example: 0.000789 },
          updated_at:    { type: 'string', format: 'date-time' },
          timestamp:     { type: 'string', format: 'date-time' },
        },
      },
      ConversionResult: {
        type: 'object',
        properties: {
          from_currency: { type: 'string', example: 'CAD' },
          to_currency:   { type: 'string', example: 'NGN' },
          from_amount:   { type: 'number', example: 1000 },
          to_amount:     { type: 'number', example: 1267500 },
          rate:          { type: 'number', example: 1267.5 },
          updated_at:    { type: 'string', format: 'date-time' },
        },
      },
      WalletBalance: {
        type: 'object',
        properties: {
          currency: { type: 'string', example: 'CAD' },
          balance: { type: 'string', example: '4749.10' },
          available: { type: 'string', example: '4749.10' },
          pending: { type: 'string', example: '0.00' },
        },
      },
      Transfer: {
        type: 'object',
        properties: {
          transfer_id: { type: 'string', example: '2332' },
          gtp_transfer_id: { type: 'string', example: '8' },
          status: { type: 'string', enum: ['processing', 'completed', 'failed'], example: 'processing' },
          amount: { type: 'string', example: '250.00' },
          currency: { type: 'string', example: 'CAD' },
          recipient: {
            type: 'object',
            properties: {
              bank_name: { type: 'string', example: 'Interac' },
              account_number: { type: 'string', example: 'recipient@example.com' },
              account_name: { type: 'string', example: 'Jane Doe' },
            },
          },
          client_reference: { type: 'string', example: 'TRF-CAD-001' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        description: 'Returns `ok` if the service is running. No authentication required.',
        security: [],
        responses: {
          200: { description: 'Service is healthy', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } } } } },
        },
      },
    },

    // ── RATES ────────────────────────────────────────────────────────────────
    '/api/rates': {
      get: {
        tags: ['Exchange Rates'],
        summary: 'List all rates (spread applied)',
        description: 'Returns every available currency pair with the spread-adjusted customer rate.',
        responses: {
          200: {
            description: 'All rates with spread',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: {
                      type: 'object',
                      properties: {
                        rates: { type: 'array', items: { $ref: '#/components/schemas/RateQuote' } },
                        count: { type: 'integer', example: 6 },
                        timestamp: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/rates/convert': {
      get: {
        tags: ['Exchange Rates'],
        summary: 'Calculate a conversion',
        description: 'Calculates how much the recipient receives for a given amount. Use this to preview before sending.',
        parameters: [
          { name: 'amount', in: 'query', required: true, schema: { type: 'number', example: 1000 } },
          { name: 'from_currency', in: 'query', required: true, schema: { type: 'string', example: 'CAD' } },
          { name: 'to_currency', in: 'query', required: true, schema: { type: 'string', example: 'NGN' } },
        ],
        responses: {
          200: {
            description: 'Conversion breakdown',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/ConversionResult' } } } } },
          },
          400: { description: 'Invalid parameters' },
        },
      },
    },
    '/api/rates/{from_currency}/{to_currency}': {
      get: {
        tags: ['Exchange Rates'],
        summary: 'Get rate for a currency pair',
        description: 'Returns the spread-adjusted rate for one specific currency pair.',
        parameters: [
          { name: 'from_currency', in: 'path', required: true, schema: { type: 'string', example: 'CAD' } },
          { name: 'to_currency', in: 'path', required: true, schema: { type: 'string', example: 'NGN' } },
        ],
        responses: {
          200: {
            description: 'Rate quote',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/RateQuote' } } } } },
          },
          404: { description: 'Currency pair not found' },
        },
      },
    },

    // ── TRANSFERS ────────────────────────────────────────────────────────────
    '/api/transfers': {
      post: {
        tags: ['Transfers'],
        summary: 'Initiate a payout',
        description: `Send funds to a recipient's bank account. Supports NGN (bank transfer), CAD (Interac eTransfer), USD (wire), GBP, and EUR.

**NGN:** Requires \`bank_id\`, \`account_number\`, \`account_name\`.
**CAD:** Requires \`recipient_email\` (Interac eTransfer).
**USD:** Requires \`account_number\`, \`bank_name\`, \`routing_number\`, \`email\`, \`account_type\`.`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              examples: {
                NGN: {
                  summary: 'NGN bank transfer',
                  value: { bank_id: 10, account_number: '0123456789', account_name: 'John Doe', amount: '50000.00', currency: 'NGN', description: 'Payout', client_reference: 'TRF-001' },
                },
                CAD: {
                  summary: 'CAD Interac eTransfer',
                  value: { recipient_email: 'jane@example.com', amount: '250.00', currency: 'CAD', description: 'CAD payout', client_reference: 'TRF-002' },
                },
                USD: {
                  summary: 'USD wire transfer',
                  value: { account_number: '123456789', account_name: 'John Doe', bank_name: 'Chase', routing_number: '021000021', email: 'john@example.com', account_type: 'checking', amount: '500.00', currency: 'USD', client_reference: 'TRF-003' },
                },
              },
              schema: {
                type: 'object',
                required: ['amount', 'currency', 'client_reference'],
                properties: {
                  amount: { type: 'string', example: '250.00' },
                  currency: { type: 'string', enum: ['NGN', 'CAD', 'USD', 'GBP', 'EUR'], example: 'NGN' },
                  client_reference: { type: 'string', example: 'TRF-001', description: 'Your unique reference (idempotency key)' },
                  description: { type: 'string', example: 'Payout for services' },
                  bank_id: { type: 'integer', example: 10, description: 'NGN only — from GET /api/account/banks' },
                  account_number: { type: 'string', example: '0123456789' },
                  account_name: { type: 'string', example: 'John Doe' },
                  recipient_email: { type: 'string', example: 'jane@example.com', description: 'CAD only — Interac eTransfer email' },
                  bank_name: { type: 'string', description: 'USD only' },
                  routing_number: { type: 'string', description: 'USD only — 9-digit routing number' },
                  email: { type: 'string', description: 'USD only' },
                  account_type: { type: 'string', enum: ['checking', 'savings'], description: 'USD only' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Transfer initiated', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { transfer: { $ref: '#/components/schemas/Transfer' } } } } } } } },
          400: { description: 'Validation error — check required fields for the target currency' },
          401: { description: 'Invalid or missing API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          429: { description: 'Rate limit exceeded (20 transfers/min)', content: { 'application/json': { schema: { $ref: '#/components/schemas/RateLimitError' } } } },
        },
      },
    },
    '/api/transfers/list': {
      get: {
        tags: ['Transfers'],
        summary: 'List all transfers',
        parameters: [
          { name: 'currency', in: 'query', schema: { type: 'string', example: 'NGN' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['processing', 'completed', 'failed'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', example: 1 } },
          { name: 'page_size', in: 'query', schema: { type: 'integer', example: 20 } },
        ],
        responses: { 200: { description: 'Transfer list' } },
      },
    },
    '/api/transfers/verification': {
      get: {
        tags: ['Transfers'],
        summary: 'Look up transfer by your reference',
        parameters: [
          { name: 'reference', in: 'query', required: true, schema: { type: 'string', example: 'TRF-001' } },
        ],
        responses: { 200: { description: 'Transfer details' }, 404: { description: 'Not found' } },
      },
    },
    '/api/transfers/{transfer_id}': {
      get: {
        tags: ['Transfers'],
        summary: 'Get transfer by ID',
        parameters: [
          { name: 'transfer_id', in: 'path', required: true, schema: { type: 'string', example: '2332' } },
        ],
        responses: { 200: { description: 'Transfer details' }, 404: { description: 'Not found' } },
      },
    },

    // ── SWAPS ────────────────────────────────────────────────────────────────
    '/api/swaps': {
      post: {
        tags: ['Swaps'],
        summary: 'Execute a currency swap',
        description: `Converts funds between two of your wallets at the live market rate.

The response includes a settlement breakdown showing the exact amounts exchanged.
Use \`GET /api/rates/convert\` first to preview before executing.`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['from_wallet_id', 'to_wallet_id', 'amount', 'from_currency', 'to_currency'],
                properties: {
                  from_wallet_id: { type: 'string', example: '2746' },
                  to_wallet_id: { type: 'string', example: '2748' },
                  amount: { type: 'string', example: '1000.00' },
                  from_currency: { type: 'string', example: 'CAD' },
                  to_currency: { type: 'string', example: 'NGN' },
                  lock_rate: { type: 'boolean', default: false },
                  reference: { type: 'string', example: 'SWAP-001' },
                },
              },
            },
          },
        },
        responses: {
          401: { description: 'Invalid or missing API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          429: { description: 'Rate limit exceeded (20 swaps/min)', content: { 'application/json': { schema: { $ref: '#/components/schemas/RateLimitError' } } } },
          201: {
            description: 'Swap executed',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    swap: {},
                    settlement: {
                      from_amount:   1000,
                      from_currency: 'CAD',
                      to_amount:     1267500,
                      to_currency:   'NGN',
                      rate:          1267.5,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/swaps/list': {
      get: {
        tags: ['Swaps'],
        summary: 'List all swaps',
        parameters: [
          { name: 'currency', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { 200: { description: 'Swap history' } },
      },
    },
    '/api/swaps/{swap_id}': {
      get: {
        tags: ['Swaps'],
        summary: 'Get swap by ID',
        parameters: [{ name: 'swap_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Swap details' } },
      },
    },

    // ── WALLETS ──────────────────────────────────────────────────────────────
    '/api/wallets': {
      get: {
        tags: ['Wallets'],
        summary: 'List all wallets',
        description: 'Returns all active wallets with full balance, pending, and ledger information.',
        responses: { 200: { description: 'Wallet list' } },
      },
    },
    '/api/wallets/balances': {
      get: {
        tags: ['Wallets'],
        summary: 'Quick balance summary',
        description: 'Returns available, pending, and total balance for every currency in one call.',
        responses: {
          200: {
            description: 'All balances',
            content: {
              'application/json': {
                example: {
                  data: {
                    balances: [
                      { currency: 'CAD', balance: '4749.10', available: '4749.10', pending: '0.00' },
                      { currency: 'NGN', balance: '450000.00', available: '450000.00', pending: '0.00' },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/wallets/{currency}': {
      get: {
        tags: ['Wallets'],
        summary: 'Get wallet by currency',
        parameters: [{ name: 'currency', in: 'path', required: true, schema: { type: 'string', example: 'CAD' } }],
        responses: { 200: { description: 'Wallet detail' }, 404: { description: 'Wallet not found' } },
      },
    },
    '/api/wallets/{currency}/transactions': {
      get: {
        tags: ['Wallets'],
        summary: 'Wallet transaction history',
        parameters: [
          { name: 'currency', in: 'path', required: true, schema: { type: 'string', example: 'CAD' } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'page_size', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { 200: { description: 'Transaction list' } },
      },
    },

    // ── ACCOUNT ──────────────────────────────────────────────────────────────
    '/api/account': {
      get: {
        tags: ['Account'],
        summary: 'Get account details',
        description: 'Returns your company account info, KYB status, and all linked bank accounts.',
        responses: { 200: { description: 'Account details' } },
      },
      patch: {
        tags: ['Account'],
        summary: 'Update account settings',
        description: 'Update contact info or webhook URL. Only fields provided will be changed.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  contact_email: { type: 'string', format: 'email' },
                  contact_phone: { type: 'string', example: '+14165559999' },
                  webhook_url: { type: 'string', format: 'uri', example: 'https://api.zeehfi.ca/webhooks/receive' },
                  metadata: { type: 'object' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Updated fields confirmed' } },
      },
    },
    '/api/account/banks': {
      get: {
        tags: ['Account'],
        summary: 'List available banks',
        description: 'Get bank codes and names for a given currency. Use `bank_id` from this list when initiating NGN transfers.',
        parameters: [
          { name: 'currency', in: 'query', required: true, schema: { type: 'string', enum: ['NGN', 'CAD', 'USD', 'GBP', 'EUR'], example: 'NGN' } },
        ],
        responses: { 200: { description: 'Bank list with codes' } },
      },
    },
    '/api/account/banks/validate': {
      post: {
        tags: ['Account'],
        summary: 'Validate a bank account',
        description: 'Verify an account number before sending. Returns the account holder name if valid.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              examples: {
                NGN: { summary: 'NGN account', value: { currency: 'NGN', bank_code: '10', account_number: '0123456789' } },
                CAD: { summary: 'CAD eTransfer', value: { currency: 'CAD', account_number: 'recipient@example.com' } },
              },
              schema: {
                type: 'object',
                required: ['currency', 'account_number'],
                properties: {
                  currency: { type: 'string', example: 'NGN' },
                  bank_code: { type: 'string', example: '10', description: 'Required for NGN only' },
                  account_number: { type: 'string', example: '0123456789' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Account is valid',
            content: {
              'application/json': {
                example: { data: { valid: true, account_name: 'okey Joy Chidimma', account_number: '0123456789', bank: { id: 10, name: 'ACCESS BANK' } } },
              },
            },
          },
        },
      },
    },
    '/api/account/transactions': {
      get: {
        tags: ['Account'],
        summary: 'Full transaction history',
        description: 'Unified view of all transfers, swaps, and wallet funding across all currencies.',
        parameters: [
          { name: 'currency', in: 'query', schema: { type: 'string' } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['transfer', 'swap', 'wallet_funding', 'all'] } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'page_size', in: 'query', schema: { type: 'integer', example: 20 } },
        ],
        responses: { 200: { description: 'Transaction history with pagination' } },
      },
    },

    // ── WEBHOOKS ─────────────────────────────────────────────────────────────
    '/api/webhooks': {
      post: {
        tags: ['Webhooks'],
        summary: 'Register webhook URL',
        description: `Set the URL that GTP will call when payment events occur (transfer completed, swap completed, etc.).

> **Tip:** Use \`PATCH /api/account\` with \`webhook_url\` as an alternative — both set the same value.

Your webhook receiver is already live at \`https://api.zeehfi.ca/webhooks/receive\` and is pre-registered.`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', format: 'uri', example: 'https://api.zeehfi.ca/webhooks/receive' },
                  description: { type: 'string', example: 'Production payment notifications' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Webhook registered' }, 400: { description: 'Invalid URL' } },
      },
    },
    '/webhooks/receive': {
      post: {
        tags: ['Webhooks'],
        summary: 'Webhook event receiver (GTP → you)',
        description: `GTP calls this endpoint automatically when a payment event occurs. **No API key required** — this is a public inbound endpoint.

**Event types:**
| Type | Description |
|---|---|
| \`transfer.completed\` | Payout successfully delivered |
| \`transfer.failed\` | Payout failed |
| \`swap.completed\` | Currency swap completed |
| \`wallet.funded\` | Wallet received a deposit |

Respond with **HTTP 200** within 10 seconds — GTP will retry on failure.`,
        security: [],
        requestBody: {
          content: {
            'application/json': {
              example: {
                event: 'transfer.completed',
                data: {
                  transfer_id: '2333',
                  status: 'completed',
                  amount: '10000.00',
                  currency: 'NGN',
                  client_reference: 'TRF-WEBHOOK-TEST-001',
                  recipient: { bank_name: 'ACCESS BANK', account_number: '0123456789', account_name: 'okey Joy Chidimma' },
                  completed_at: '2026-05-26T05:20:00.000Z',
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
