# Funding & Checking Your Balance

### Checking your balance

```bash
GET /api/balance                       # all currencies
GET /api/balance/CAD                   # one currency
GET /api/balance/transactions/history  # full ledger history
```

### Funding your account

```bash
curl "https://api.zeehfi.ca/api/wallets/deposit/CAD" \
  -H "x-api-key: YOUR_KEY"
```

This returns the exact bank details / Interac email to send funds to for that currency. Funds are typically credited within minutes of a confirmed deposit.

{% hint style="info" %}
Contact support if a deposit doesn't reflect after 30 minutes.
{% endhint %}

Next: [Webhooks →](webhooks.md)
