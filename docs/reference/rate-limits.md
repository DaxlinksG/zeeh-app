# Rate Limits

| Scope | Limit |
|---|---|
| Global | 120 requests / minute |
| Transfers & Swaps | 20 requests / minute |
| Rates | 300 requests / minute |

Exceeding a limit returns `429`. Respect the `Retry-After` behavior — back off for 60 seconds before retrying.

Next: [Going Live Checklist →](../going-live.md)
