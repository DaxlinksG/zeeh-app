// Spread percentages per currency corridor.
// Key: "FROM_TO" (uppercase). Value: spread as a percentage (e.g. 2.5 = 2.5%).
//
// The spread is applied against the customer: they receive a worse rate than the
// raw GTP rate. The difference between raw_rate and customer_rate is your margin.
//
//   customer_rate = raw_rate * (1 - spreadPct / 100)
//   margin_per_unit = raw_rate - customer_rate

export const corridorSpreads: Record<string, number> = {
  // CAD corridors
  CAD_NGN: 2.5,
  CAD_USD: 1.0,
  CAD_GBP: 1.5,
  CAD_EUR: 1.5,

  // USD corridors
  USD_NGN: 3.0,
  USD_CAD: 1.0,
  USD_GBP: 1.5,
  USD_EUR: 1.5,

  // GBP corridors
  GBP_NGN: 2.5,
  GBP_USD: 1.5,
  GBP_EUR: 1.0,
  GBP_CAD: 1.5,

  // EUR corridors
  EUR_NGN: 2.5,
  EUR_USD: 1.5,
  EUR_GBP: 1.0,
  EUR_CAD: 1.5,
};

export function getSpreadPct(fromCurrency: string, toCurrency: string): number {
  const key = `${fromCurrency.toUpperCase()}_${toCurrency.toUpperCase()}`;
  const corridor = corridorSpreads[key];
  if (corridor !== undefined) return corridor;
  return parseFloat(process.env.DEFAULT_SPREAD_PCT ?? '2.0');
}
