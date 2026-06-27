# Quickstart: Your First Payout

### Step 1 — Check your balance

```bash
curl https://api.zeehfi.ca/api/balance \
  -H "x-api-key: YOUR_KEY"
```

### Step 2 (NGN / African bank transfers only) — Look up the bank code

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

A successful response returns `201` with the transfer details. The transfer then moves to `processing`, and you'll get a [webhook](../guides/webhooks.md) once it settles.

### Example: mobile money payout (Kenya)

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

{% hint style="info" %}
Different currencies require different fields — NGN needs `bank_id` + `account_number`, Kenyan mobile money needs `msisdn` instead. See [Supported Corridors](../core-concepts/corridors.md) for how to query required fields per currency rather than hardcoding them.
{% endhint %}

Next: [Supported Corridors →](../core-concepts/corridors.md)
