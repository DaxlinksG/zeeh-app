# Going Live Checklist

- [ ] Tested a full transfer flow end-to-end in sandbox (quote → validate → transfer → webhook)
- [ ] Webhook endpoint registered and verified to respond `200` within 10 seconds
- [ ] `client_reference` generation is unique per transfer (no collisions)
- [ ] Error handling covers `402` (insufficient balance) and `503` (frozen currency) gracefully in your UI
- [ ] Production API key requested and stored securely
- [ ] Account funded with enough balance for expected initial volume

Next: [Support →](support.md)
