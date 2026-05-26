import { getSpreadPct } from '../config/spread';

export interface RateQuote {
  fromCurrency: string;
  toCurrency: string;
  rawRate: number;          // GTP's real interbank rate
  spreadPct: number;        // markup applied (%)
  customerRate: number;     // rate shown/charged to the customer
  inverseCustomerRate: number;
  timestamp: string;
  expiresAt: string;
  source: string;
}

export interface ConversionResult {
  fromCurrency: string;
  toCurrency: string;
  fromAmount: number;
  toAmount: number;           // what the customer receives
  customerRate: number;
  spreadPct: number;
  spreadRevenue: number;      // margin captured in toCurrency
  rawToAmount: number;        // what GTP would give at interbank rate
}

export function buildQuote(
  fromCurrency: string,
  toCurrency: string,
  rawRate: number,
  timestamp: string,
  expiresAt: string,
  source: string,
): RateQuote {
  const spreadPct = getSpreadPct(fromCurrency, toCurrency);
  const customerRate = rawRate * (1 - spreadPct / 100);

  return {
    fromCurrency: fromCurrency.toUpperCase(),
    toCurrency: toCurrency.toUpperCase(),
    rawRate,
    spreadPct,
    customerRate: round(customerRate, 6),
    inverseCustomerRate: round(1 / customerRate, 6),
    timestamp,
    expiresAt,
    source,
  };
}

export function calcConversion(amount: number, quote: RateQuote): ConversionResult {
  const rawToAmount = amount * quote.rawRate;
  const toAmount = amount * quote.customerRate;
  const spreadRevenue = rawToAmount - toAmount;

  return {
    fromCurrency: quote.fromCurrency,
    toCurrency: quote.toCurrency,
    fromAmount: amount,
    toAmount: round(toAmount, 2),
    customerRate: quote.customerRate,
    spreadPct: quote.spreadPct,
    spreadRevenue: round(spreadRevenue, 2),
    rawToAmount: round(rawToAmount, 2),
  };
}

function round(value: number, decimals: number): number {
  return parseFloat(value.toFixed(decimals));
}
