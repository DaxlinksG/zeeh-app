# Virtual Accounts (for your end-customers)

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

Next: [Error Handling →](../reference/errors.md)
