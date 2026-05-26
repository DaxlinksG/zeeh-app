# Zeeh Africa — Cross-Border Payments API

A production-ready payment service that enables cross-border money transfers and currency conversions across **CAD, NGN, USD, GBP, and EUR** — with a built-in **spread engine** that generates revenue on every transaction.

Built on top of the [GTP/Expedier](https://expedier.co) network.

---

## What this service does

| Capability | Details |
|---|---|
| **Exchange rates** | Live rates fetched from GTP, markup applied per corridor |
| **Conversion quotes** | Show customers what they receive, reveal your margin |
| **Transfers** | NGN bank payouts, CAD Interac eTransfers, USD wire, GBP, EUR |
| **Currency swaps** | Convert between your multi-currency wallets |
| **Webhooks** | Real-time payment event notifications |
| **Interactive docs** | Swagger UI at `/docs` — explore and test every endpoint |

---

## How the spread works

Your revenue comes from the difference between the raw interbank rate (GTP) and the rate you show your customer:

```
customer_rate = raw_rate × (1 − spread_pct / 100)

Example — customer sends 1,000 CAD to Nigeria:
  GTP rate (interbank):   1,300 NGN / CAD
  Spread (CAD → NGN):     2.5 %
  Customer rate:          1,267.5 NGN / CAD
  Customer receives:      1,267,500 NGN
  Your margin:              32,500 NGN  (~$25 CAD)
```

Spreads are configured per corridor in `src/config/spread.ts`:

| Corridor | Spread |
|---|---|
| CAD → NGN | 2.5 % |
| CAD → USD | 1.0 % |
| USD → NGN | 3.0 % |
| GBP → NGN | 2.5 % |
| EUR → NGN | 2.5 % |
| *(all others)* | 2.0 % (default) |

---

## Prerequisites

- **Node.js** v18 or higher — [nodejs.org](https://nodejs.org)
- A **GTP sandbox API key** from [Expedier](https://expedier.co)

---

## Quick start

```bash
# 1. Clone / open the project
cd ~/Desktop/gtp-payments

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Then open .env and fill in your GTP_API_KEY

# 4. Start the development server
npm run dev
```

The server starts at **http://localhost:3000**
Interactive docs at **http://localhost:3000/docs**

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port to listen on (default: `3000`) |
| `GTP_BASE_URL` | Yes | GTP API base URL (sandbox or production) |
| `GTP_API_KEY` | Yes | Your GTP API key |
| `SERVICE_API_KEY` | Yes | Key YOUR clients must send in `x-api-key` header |
| `DEFAULT_SPREAD_PCT` | No | Fallback spread for unlisted corridors (default: `2.0`) |

---

## API reference

Full interactive documentation is available at **`/docs`** when the server is running.

### Exchange rates

```
GET  /api/rates                                — all rates (spread applied)
GET  /api/rates/:from/:to                      — single pair rate
GET  /api/rates/convert?amount=&from=&to=      — conversion with margin breakdown
GET  /api/rates/spreads                        — view your spread config
```

### Transfers (payouts)

```
POST /api/transfers                            — initiate a payout
GET  /api/transfers/list                       — list all transfers
GET  /api/transfers/:id                        — get by transfer ID
GET  /api/transfers/verification?reference=    — get by your reference
```

### Swaps

```
POST /api/swaps                                — convert between wallets
GET  /api/swaps/list                           — swap history
GET  /api/swaps/:id                            — swap details
```

### Wallets

```
GET  /api/wallets                              — all wallets + full detail
GET  /api/wallets/balances                     — quick balance summary
GET  /api/wallets/:currency                    — single wallet
GET  /api/wallets/:currency/transactions       — wallet transactions
```

### Account & banks

```
GET   /api/account                             — account details + KYB status
PATCH /api/account                             — update contact info / webhook URL
GET   /api/account/banks?currency=NGN          — list banks for a currency
POST  /api/account/banks/validate              — validate recipient before sending
GET   /api/account/transactions                — full transaction history
```

### Webhooks

```
POST /api/webhooks                             — register your webhook URL with GTP
POST /webhooks/receive                         — GTP calls this (public, no auth)
```

---

## Authentication

All `/api/*` endpoints require your service API key in the request header:

```
x-api-key: your-service-api-key
```

The `/health`, `/docs`, and `/webhooks/receive` endpoints are **public** (no key needed).

---

## Example: Full cross-border payment flow

### Step 1 — Get a quote
```bash
curl "http://localhost:3000/api/rates/convert?amount=1000&from_currency=CAD&to_currency=NGN" \
  -H "x-api-key: your-key"
```
```json
{
  "data": {
    "from_amount": 1000,
    "to_amount": 1267500,
    "customer_rate": 1267.5,
    "spread_pct": 2.5,
    "spread_revenue": 32500
  }
}
```

### Step 2 — Validate the recipient
```bash
curl -X POST "http://localhost:3000/api/account/banks/validate" \
  -H "x-api-key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"currency":"NGN","bank_code":"10","account_number":"0123456789"}'
```
```json
{
  "data": { "valid": true, "account_name": "okey Joy Chidimma" }
}
```

### Step 3 — Send the money
```bash
curl -X POST "http://localhost:3000/api/transfers" \
  -H "x-api-key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "bank_id": 10,
    "account_number": "0123456789",
    "account_name": "okey Joy Chidimma",
    "amount": "50000.00",
    "currency": "NGN",
    "client_reference": "PAY-001"
  }'
```

### Step 4 — Receive the webhook
GTP will POST to your `/webhooks/receive` endpoint automatically:
```json
{
  "event": "transfer.completed",
  "data": {
    "transfer_id": "2333",
    "status": "completed",
    "amount": "50000.00",
    "currency": "NGN",
    "client_reference": "PAY-001"
  }
}
```

---

## Webhook setup

Register your webhook URL (only needs to be done once):

```bash
curl -X PATCH "http://localhost:3000/api/account" \
  -H "x-api-key: your-key" \
  -d '{"webhook_url": "https://your-domain.com/webhooks/receive"}'
```

---

## Project structure

```
src/
├── config/
│   └── spread.ts          ← corridor spreads — edit this to change your margins
├── lib/
│   ├── gtpClient.ts        ← authenticated HTTP client for GTP API
│   └── spreadEngine.ts     ← buildQuote() + calcConversion() — pure spread math
├── middleware/
│   ├── auth.ts             ← x-api-key enforcement
│   └── errorHandler.ts     ← unified error responses
├── routes/
│   ├── rates.ts            ← exchange rate endpoints (spread applied here)
│   ├── transfers.ts        ← payout endpoints
│   ├── swaps.ts            ← swap endpoints (spread applied here)
│   ├── wallets.ts          ← wallet balance endpoints
│   ├── account.ts          ← account + bank endpoints
│   └── webhooks.ts         ← webhook registration
├── openapi.ts              ← full OpenAPI 3.0 spec
└── index.ts                ← Express app + Swagger UI at /docs
```

---

## Adjusting spreads

Open `src/config/spread.ts` and change any corridor:

```typescript
export const corridorSpreads: Record<string, number> = {
  CAD_NGN: 2.5,   // ← change this
  CAD_USD: 1.0,
  USD_NGN: 3.0,
  // ...
};

export const DEFAULT_SPREAD_PCT = 2.0;  // fallback for any unlisted pair
```

Changes take effect immediately in `npm run dev` (hot reload).

---

## Build for production

```bash
npm run build        # compiles TypeScript → dist/
npm start            # runs dist/index.js
```

---

## Deploying

The service is a standard Node.js HTTP server. It can be deployed to:

- **Railway** — `railway up`
- **Render** — connect your GitHub repo, set env vars
- **Fly.io** — `fly deploy`
- **Any VPS** — run `npm start` behind nginx

After deploying, update your webhook URL:

```bash
curl -X PATCH "https://your-domain.com/api/account" \
  -H "x-api-key: your-key" \
  -d '{"webhook_url": "https://your-domain.com/webhooks/receive"}'
```

---

## Sandbox vs production

| Setting | Sandbox | Production |
|---|---|---|
| `GTP_BASE_URL` | `https://gtp-service-sandbox-...run.app/gtp/v1` | GTP production URL |
| `GTP_API_KEY` | `gtp_test_...` | `gtp_live_...` |
| Transfers | Simulated | Real money |
| Wallet funding | `POST /sandbox/wallets/fund` | Real deposits |

---

*Built by Zeeh Africa · Powered by [GTP / Expedier](https://expedier.co)*
