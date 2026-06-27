# Error Handling

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

Next: [Rate Limits →](rate-limits.md)
