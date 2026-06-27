# Authentication

Every request (except `/health`) requires your API key in the header:

```
x-api-key: zk_live_your_key_here
```

```bash
curl https://api.zeehfi.ca/api/balance \
  -H "x-api-key: zk_live_your_key_here"
```

A missing or invalid key returns `401 Unauthorized`.

Next: [Quickstart: Your First Payout →](quickstart.md)
