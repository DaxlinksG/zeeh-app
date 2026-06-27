# Core Concepts

### Your ledger balance

You hold a prepaid balance with us, per currency. Fund it in advance (see [Funding Your Account](../guides/funding-and-balance.md)), then every transfer debits from it directly. If a transfer fails on our end, you're refunded automatically.

### `client_reference` is your idempotency key

Always send a unique `client_reference` with every transfer. If you retry the same request (e.g. after a timeout) with the same reference, we return the original result instead of double-sending money.

### Currency determines required fields

A NGN transfer needs `bank_id` + `account_number` + `account_name`. A Kenyan mobile money transfer needs `msisdn` instead. Always check [`GET /api/currencies`](corridors.md) rather than assuming.

Next: [Funding Your Account →](../guides/funding-and-balance.md)
