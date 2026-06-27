# Supported Corridors

Don't hardcode a currency list — query it, since corridors and required fields can change:

```bash
curl https://api.zeehfi.ca/api/currencies \
  -H "x-api-key: YOUR_KEY"
```

This returns every currency's live `payout_status` (`active`, `contact_support`, or `coming_soon`) and the exact `payout_fields` required for a transfer in that currency. Use this to drive your own UI/form validation dynamically rather than hardcoding field requirements.

### Currency overview

| Region | Currencies | Method |
|---|---|---|
| North America | CAD, USD | Interac eTransfer, Wire/ACH |
| Nigeria | NGN | Bank transfer |
| Africa — Bank transfer | GHS, ZAR, EGP, ETB, MWK | Bank transfer |
| Africa — Mobile money | KES, TZS, UGX, RWF, ZMW, XAF, XOF, SLL | Mobile wallet (M-Pesa, Airtel, MTN, Orange, Wave, Africell) |
| Europe | GBP, EUR | Contact support to activate |

Next: [Core Concepts →](concepts.md)
