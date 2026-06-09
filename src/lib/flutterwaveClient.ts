/**
 * Flutterwave V4 client
 *
 * Auth: OAuth2 client_credentials → token valid 600s → cached, refreshed at 540s.
 * Switch between test and live by setting FLW_ENV=test|live in the environment.
 * Going live = update FLW_ENV + swap FLW_CLIENT_ID / FLW_CLIENT_SECRET in Secrets Manager.
 *
 * Sandbox base : https://developersandbox-api.flutterwave.com
 * Live base    : https://api.flutterwave.com
 * Token URL    : https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token
 */

import axios, { AxiosInstance } from 'axios';

// ── Config ────────────────────────────────────────────────────────────────────
export const FLW_ENV = (process.env.FLW_ENV ?? 'test') as 'test' | 'live';

const FLW_BASE_URL = FLW_ENV === 'live'
  ? (process.env.FLW_BASE_URL ?? 'https://api.flutterwave.com')
  : (process.env.FLW_SANDBOX_BASE_URL ?? 'https://developersandbox-api.flutterwave.com');

const FLW_CLIENT_ID     = process.env.FLW_CLIENT_ID     ?? '';
const FLW_CLIENT_SECRET = process.env.FLW_CLIENT_SECRET ?? '';

const FLW_TOKEN_URL =
  'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';

// The currency Zeeh's Flutterwave wallet is funded in.
// Flutterwave converts this to the destination currency at execution.
export const FLW_SOURCE_CURRENCY = process.env.FLW_SOURCE_CURRENCY ?? 'USD';

// ── OAuth2 token cache ────────────────────────────────────────────────────────
let _token:    string | null = null;
let _tokenExp: number        = 0;   // ms timestamp

async function getToken(): Promise<string> {
  if (_token && Date.now() < _tokenExp) return _token;

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     FLW_CLIENT_ID,
    client_secret: FLW_CLIENT_SECRET,
  });

  const { data } = await axios.post(FLW_TOKEN_URL, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15_000,
  });

  _token    = data.access_token as string;
  // expire 60 seconds early to avoid clock skew edge cases
  _tokenExp = Date.now() + ((data.expires_in as number) - 60) * 1000;
  console.log(`[flw] token refreshed — env=${FLW_ENV} expires_in=${data.expires_in}s`);
  return _token;
}

// ── Axios instance ────────────────────────────────────────────────────────────
const _inst: AxiosInstance = axios.create({
  baseURL: FLW_BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

// Attach bearer token before every outbound request
_inst.interceptors.request.use(async config => {
  const token = await getToken();
  config.headers = config.headers ?? {};
  config.headers['Authorization'] = `Bearer ${token}`;
  return config;
}, err => Promise.reject(err));

// Normalise errors to { status, upstream, message } — same shape as gtpClient
_inst.interceptors.response.use(
  res => res,
  err => {
    const status  = (err.response?.status  ?? 500) as number;
    const body    = err.response?.data;
    const message = (body?.message ?? err.message ?? 'Flutterwave error') as string;
    return Promise.reject(Object.assign(new Error(message), { status, upstream: body }));
  },
);

export const flw = _inst;

// ── Currency routing sets ─────────────────────────────────────────────────────
// NGN intentionally excluded — stays on Expedier.
// CAD / USD / GBP / EUR stay on Expedier.

export const FLW_CURRENCIES = new Set([
  // Africa — bank transfer
  'GHS', 'ZAR', 'EGP', 'ETB', 'MWK',
  // Africa — mobile money
  'KES', 'TZS', 'UGX', 'RWF', 'ZMW', 'XAF', 'XOF', 'SLL',
]);

export const FLW_MOBILE_MONEY = new Set([
  'KES', 'TZS', 'UGX', 'RWF', 'ZMW', 'XAF', 'XOF', 'SLL',
]);

// Primary mobile money network per currency (used when caller omits mobile_network)
export const FLW_DEFAULT_NETWORK: Record<string, string> = {
  KES: 'Safaricom',  // M-Pesa
  TZS: 'Airtel',
  UGX: 'MTN',
  RWF: 'MTN',
  ZMW: 'Airtel',
  XAF: 'Orange',
  XOF: 'Wave',
  SLL: 'Africell',
};

// ISO 3166-1 alpha-2 country codes (required by FLW for mobile_money.country)
export const FLW_COUNTRY: Record<string, string> = {
  KES: 'KE', TZS: 'TZ', UGX: 'UG', RWF: 'RW',
  ZMW: 'ZM', XAF: 'CM', XOF: 'CI', SLL: 'SL',
  GHS: 'GH', ZAR: 'ZA', EGP: 'EG', ETB: 'ET', MWK: 'MW',
};
