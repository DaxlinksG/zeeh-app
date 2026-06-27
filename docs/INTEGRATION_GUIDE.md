# Zeeh Africa — Integration Guide

Welcome! This guide walks you through everything you need to integrate with the Zeeh Africa Payments API — from getting your API key to sending your first payout and handling webhooks.

> 📖 Looking for full endpoint-by-endpoint reference with live request/response schemas? See the [Interactive API Docs](https://api.zeehfi.ca/docs/) — this guide is the narrative walkthrough; the Swagger docs are the detailed reference.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Getting Your API Key](#2-getting-your-api-key)
3. [Authentication](#3-authentication)
4. [Supported Corridors](#4-supported-corridors)
5. [Core Concepts](#5-core-concepts)
6. [Quickstart: Your First Payout](#6-quickstart-your-first-payout)
7. [Checking Your Balance](#7-checking-your-balance)
8. [Funding Your Account](#8-funding-your-account)
9. [Webhooks](#9-webhooks)
10. [Virtual Accounts (for your end-customers)](#10-virtual-accounts-for-your-end-customers)
11. [Error Handling](#11-error-handling)
12. [Rate Limits](#12-rate-limits)
13. [Going Live Checklist](#13-going-live-checklist)
14. [Support](#14-support)

---

## 1. Overview

Zeeh Africa gives you a single API to send money across **18 currency corridors** — bank transfers, mobile money, and Interac/wire payouts — without integrating separately with a different provider for every country.

| Region | Currencies | Method |
|---|---|---|
| North America | CAD, USD | Interac eTransfer, Wire/ACH |
| Nigeria | NGN | Bank transfer |
| Africa — Bank transfer | GHS, ZAR, EGP, ETB, MWK | Bank transfer |
| Africa — Mobile money | KES, TZS, UGX, RWF, ZMW, XAF, XOF, SLL | Mobile wallet (M-Pesa, Airtel, MTN, Orange, Wave, Africell) |
| Europe | GBP, EUR | Contact support to activate |

Every transfer you send is debited from **your own prepaid ledger balance** with us — you top up in advance, then draw down as you send payouts. There's no per-transaction credit check or settlement delay on your end.

---

## 2. Getting Your API Key

Contact **zeehafricah@gmail.com** with your company name and use case. You'll receive:

- A live API key (`zk_live_...`) — keep this secret, never expose it client-side
- A test/sandbox key for development, if requested

> ⚠️ Your API key is shown to you exactly once when issued. Store it securely (e.g. in a secrets manager) — we cannot retrieve it for you if lost, only reissue a new one.

---

## 3. Authentication

Every request (except `/health`) requires your API key in the header:

```
x-api-key: zk_live_your_key_here
```

```bash
curl https://api.zeehfi.ca/api/balance \
  -H "x-api-key: zk_live_your_key_here"
```

A missing or invalid key returns `401 Unauthorized`.

---

## 4. Supported Corridors

Don't hardcode a currency list — query it, since corridors and required fields can change:

```bash
curl https://api.zeehfi.ca/api/currencies \
  -H "x-api-key: YOUR_KEY"
```

This returns every currency's live `payout_status` (`active`, `contact_support`, or `coming_soon`) and the exact `payout_fields` required for a transfer in that currency. Use this to drive your own UI/form validation dynamically rather than hardcoding field requirements.

---

## 5. Core Concepts

**Your ledger balance.** You hold a prepaid balance with us, per currency. Fund it in advance (see [§8](#8-funding-your-account)), then every transfer debits from it directly. If a transfer fails on our end, you're refunded automatically.

**`client_reference` is your idempotency key.** Always send a unique `client_reference` with every transfer. If you retry the same request (e.g. after a timeout) with the same reference, we return the original result instead of double-sending money.

**Currency determines required fields.** A NGN transfer needs `bank_id` + `account_number` + `account_name`. A Kenyan mobile money transfer needs `msisdn` instead. Always check `GET /api/currencies` rather than assuming.

---

## 6. Quickstart: Your First Payout

### Step 1 — Check your balance

```bash
curl https://api.zeehfi.ca/api/balance \
  -H "x-api-key: YOUR_KEY"
```

### Step 2 (NGN/African bank transfers only) — Look up the bank code

```bash
curl "https://api.zeehfi.ca/api/account/banks?currency=NGN" \
  -H "x-api-key: YOUR_KEY"
```

### Step 3 (recommended) — Validate the recipient account

```bash
curl -X POST https://api.zeehfi.ca/api/account/banks/validate \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"currency":"NGN","bank_code":"044","account_number":"0123456789"}'
```

This confirms the account holder's name before you commit to sending — skipping this risks a failed or misdirected payout.

### Step 4 — Send the transfer

```bash
curl -X POST https://api.zeehfi.ca/api/transfers \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "currency": "NGN",
    "amount": "50000.00",
    "bank_id": 10,
    "account_number": "0123456789",
    "account_name": "John Doe",
    "description": "Salary payment",
    "client_reference": "PAY-2026-001"
  }'
```

A successful response returns `201` with the transfer details. The transfer then moves to `processing`, and you'll get a webhook (see [§9](#9-webhooks)) once it settles.

**Example for a mobile money payout (Kenya):**

```bash
curl -X POST https://api.zeehfi.ca/api/transfers \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "currency": "KES",
    "amount": "2000.00",
    "msisdn": "254712345678",
    "recipient_first_name": "James",
    "recipient_last_name": "Kamau",
    "client_reference": "PAY-2026-002"
  }'
```

---

## 7. Checking Your Balance

```bash
GET /api/balance                       # all currencies
GET /api/balance/CAD                   # one currency
GET /api/balance/transactions/history  # full ledger history
```

---

## 8. Funding Your Account

```bash
curl "https://api.zeehfi.ca/api/wallets/deposit/CAD" \
  -H "x-api-key: YOUR_KEY"
```

This returns the exact bank details / Interac email to send funds to for that currency. Funds are typically credited within minutes of a confirmed deposit. Contact support if a deposit doesn't reflect after 30 minutes.

---

## 9. Webhooks

Register your webhook endpoint once:

```bash
curl -X PATCH https://api.zeehfi.ca/api/account \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"webhook_url": "https://yourapp.com/webhooks/zeeh"}'
```

We'll POST to that URL on these events:

| Event | When it fires |
|---|---|
| `transfer.completed` | Payout successfully delivered |
| `transfer.failed` | Payout failed (you've already been refunded) |
| `swap.completed` | A currency swap finished |
| `wallet.funded` | A deposit was credited to your balance |
| `virtual_account.credited` | One of your virtual accounts received a deposit |

**Your endpoint must respond `200` within 10 seconds.** Failed deliveries are retried automatically. We recommend acknowledging immediately and processing the event asynchronously.

```json
{
  "event": "transfer.completed",
  "data": {
    "transfer_id": "2332",
    "status": "completed",
    "amount": "50000.00",
    "currency": "NGN",
    "client_reference": "PAY-2026-001",
    "completed_at": "2026-06-21T08:07:32.000Z"
  }
}
```

---

## 10. Virtual Accounts (for your end-customers)

If you have your own customers depositing funds that need to be tracked individually, create a virtual account per customer:

```bash
curl -X POST https://api.zeehfi.ca/api/virtual-accounts \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": "CUST-001",
    "customer_name": "Jane Smith",
    "currency": "CAD"
  }'
```

You'll get back a unique `reference_code` and deposit instructions to share with your customer. Once they deposit using that reference, it's automatically matched and credited — you get a `virtual_account.credited` webhook, and your ledger balance increases.

You can also tag a payout to a virtual account for reconciliation by passing `virtual_account_id` in your transfer request.

---

## 11. Error Handling

All errors follow this shape:

```json
{
  "success": false,
  "message": "Human-readable description",
  "code": "MACHINE_READABLE_CODE"
}
```

| HTTP Status | Meaning |
|---|---|
| `400` | Validation error — check `errors` field for which fields failed |
| `401` | Missing or invalid API key |
| `402` | Insufficient balance — check `data.required` vs `data.available` |
| `404` | Resource not found |
| `429` | Rate limited — back off and retry |
| `503` | Currency temporarily suspended (`CURRENCY_FROZEN`) — retry later |

---

## 12. Rate Limits

| Scope | Limit |
|---|---|
| Global | 120 requests / minute |
| Transfers & Swaps | 20 requests / minute |
| Rates | 300 requests / minute |

Exceeding a limit returns `429`. Respect the `Retry-After` behavior — back off for 60 seconds before retrying.

---

## 13. Going Live Checklist

- [ ] Tested a full transfer flow end-to-end in sandbox (quote → validate → transfer → webhook)
- [ ] Webhook endpoint registered and verified to respond `200` within 10 seconds
- [ ] `client_reference` generation is unique per transfer (no collisions)
- [ ] Error handling covers `402` (insufficient balance) and `503` (frozen currency) gracefully in your UI
- [ ] Production API key requested and stored securely
- [ ] Account funded with enough balance for expected initial volume

---

## 14. Support

- **Email:** zeehafricah@gmail.com
- **API Reference:** https://api.zeehfi.ca/docs/
- **Health status:** https://api.zeehfi.ca/health

---

*Zeeh Africa — cross-border payments infrastructure for Africa and beyond.*
