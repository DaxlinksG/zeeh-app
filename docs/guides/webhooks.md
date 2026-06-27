# Webhooks

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

{% hint style="warning" %}
Your endpoint must respond `200` within 10 seconds. Failed deliveries are retried automatically. We recommend acknowledging immediately and processing the event asynchronously.
{% endhint %}

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

Next: [Virtual Accounts →](virtual-accounts.md)
