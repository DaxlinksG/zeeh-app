import axios, { AxiosInstance, AxiosError } from 'axios';

const RC_BASE = process.env.RC_BASE_URL ?? 'https://merchant-api.remitclick.com/merchant/v1';

function buildClient(): AxiosInstance {
  const client = axios.create({
    baseURL: RC_BASE,
    headers: { 'Content-Type': 'application/json' },
    timeout: 20_000,
  });

  client.interceptors.request.use((config) => {
    const key = process.env.RC_API_KEY;
    if (key) config.headers['Authorization'] = `Bearer ${key}`;
    return config;
  });

  client.interceptors.response.use(
    (res) => res,
    (err: AxiosError) => {
      const status = err.response?.status ?? 500;
      const body = err.response?.data as Record<string, unknown> | undefined;
      const message = (body?.message as string) ?? err.message ?? 'RemitClick API error';
      const rcError = new Error(message) as Error & { status: number; upstream: unknown };
      rcError.status = status;
      rcError.upstream = body;
      return Promise.reject(rcError);
    },
  );

  return client;
}

const rc = buildClient();

// ── Types ──────────────────────────────────────────────────────────────────

export interface RcCustomer {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  createdAt: string;
}

export interface RcFxQuote {
  from: string;
  to: string;
  amount: number;          // input amount (source currency)
  rate: number;            // 1 unit of `from` = rate units of `to`
  convertedAmount: number; // amount in destination currency
  fee?: number;
  expiresAt?: string;
}

export interface RcRecipient {
  accountNumber: string;
  bankCode: string;
  accountName: string;
  bankName?: string;
  currency: string;
}

export interface RcPayout {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  amount: number;
  currency: string;
  sourceCurrency?: string;
  recipient: RcRecipient;
  customerId?: string;
  reference?: string;
  createdAt: string;
  completedAt?: string;
  failureReason?: string;
}

export interface RcDeposit {
  id: string;
  customerId: string;
  currency: string;
  amount: number;
  status: string;
  createdAt: string;
}

export interface RcBalance {
  currency: string;
  available: number;
  pending: number;
}

export interface RcDepositEmailStatus {
  email: string;
  status: 'ready' | 'verify_required';
}

export interface RcCounterparty {
  id: string;
  accountNumber: string;
  bankCode: string;
  accountName: string;
  bankName?: string;
  currency: string;
  createdAt: string;
}

// ── Customer ───────────────────────────────────────────────────────────────

export async function rcCreateCustomer(email: string, firstName?: string, lastName?: string): Promise<RcCustomer> {
  const res = await rc.post<RcCustomer>('/customers', { email, firstName, lastName });
  return res.data;
}

export async function rcGetCustomer(customerId: string): Promise<RcCustomer> {
  const res = await rc.get<RcCustomer>(`/customers/${customerId}`);
  return res.data;
}

// ── Interac sender-email verification ─────────────────────────────────────

export async function rcCheckDepositEmail(customerId: string, email: string): Promise<RcDepositEmailStatus> {
  const res = await rc.post<RcDepositEmailStatus>(`/customers/${customerId}/deposit-emails/check`, { email });
  return res.data;
}

export async function rcConfirmDepositEmail(customerId: string, email: string, otp: string): Promise<{ success: boolean }> {
  const res = await rc.post<{ success: boolean }>(`/customers/${customerId}/deposit-emails/confirm`, { email, otp });
  return res.data;
}

export async function rcListDepositEmails(customerId: string): Promise<RcDepositEmailStatus[]> {
  const res = await rc.get<RcDepositEmailStatus[]>(`/customers/${customerId}/deposit-emails`);
  return res.data;
}

// ── FX quote ───────────────────────────────────────────────────────────────

export async function rcGetQuote(from: string, to: string, amount: number): Promise<RcFxQuote> {
  const res = await rc.get<RcFxQuote>('/fx-rates/quote', {
    params: { from, to, amount },
  });
  return res.data;
}

// ── Payouts ────────────────────────────────────────────────────────────────

export interface RcCreatePayoutParams {
  amount: number;           // what recipient receives (major units)
  currency: string;         // recipient currency (e.g. "NGN")
  sourceCurrency?: string;  // if cross-currency, e.g. "CAD" — debits CAD wallet
  recipient?: RcRecipient;
  counterpartyId?: string;  // saved counterparty instead of inline recipient
  customerId?: string;
  reference?: string;
}

export async function rcCreatePayout(params: RcCreatePayoutParams): Promise<RcPayout> {
  const res = await rc.post<RcPayout>('/payouts', params);
  return res.data;
}

export async function rcGetPayout(payoutId: string): Promise<RcPayout> {
  const res = await rc.get<RcPayout>(`/payouts/${payoutId}`);
  return res.data;
}

export async function rcGetDeposit(depositId: string): Promise<RcDeposit> {
  const res = await rc.get<RcDeposit>(`/deposits/${depositId}`);
  return res.data;
}

// ── Balances ───────────────────────────────────────────────────────────────

export async function rcGetBalances(): Promise<RcBalance[]> {
  const res = await rc.get<RcBalance[]>('/balances');
  return res.data;
}

// ── Counterparties (saved beneficiaries) ──────────────────────────────────

export interface RcCreateCounterpartyParams {
  accountNumber: string;
  bankCode: string;
  accountName: string;
  bankName?: string;
  currency: string;
}

export async function rcCreateCounterparty(params: RcCreateCounterpartyParams): Promise<RcCounterparty> {
  const res = await rc.post<RcCounterparty>('/counterparties', params);
  return res.data;
}

export async function rcListCounterparties(): Promise<RcCounterparty[]> {
  const res = await rc.get<RcCounterparty[]>('/counterparties');
  return res.data;
}

// ── Payment requests (shareable pay link) ─────────────────────────────────

export interface RcPaymentRequest {
  id: string;
  token: string;
  status: 'pending' | 'paid' | 'cancelled';
  amount: number;
  currency: string;
  customerId: string;
  reference?: string;
  payTo?: Record<string, unknown>;
  createdAt: string;
}

export async function rcCreatePaymentRequest(customerId: string, amount: number, currency: string, reference?: string): Promise<RcPaymentRequest> {
  const res = await rc.post<RcPaymentRequest>('/payment-requests', { customerId, amount, currency, reference });
  return res.data;
}

export async function rcGetPaymentRequest(id: string): Promise<RcPaymentRequest> {
  const res = await rc.get<RcPaymentRequest>(`/payment-requests/${id}`);
  return res.data;
}

// ── Virtual Accounts ───────────────────────────────────────────────────────

export interface RcVirtualAccount {
  id: string;
  customerId: string;
  walletId: string;
  currency: string;
  livemode: boolean;
  accountNumber: string;
  accountName?: string;
  bankName?: string;
  providerName: string;
  createdAt: string;
}

export async function rcProvisionVirtualAccount(customerId: string, currency: string): Promise<RcVirtualAccount> {
  const res = await rc.post<RcVirtualAccount>(`/customers/${customerId}/virtual-accounts`, { currency });
  return res.data;
}

export async function rcListVirtualAccounts(customerId: string): Promise<RcVirtualAccount[]> {
  const res = await rc.get<RcVirtualAccount[]>(`/customers/${customerId}/virtual-accounts`);
  return res.data;
}

// ── Exchanges ──────────────────────────────────────────────────────────────

export interface RcExchangeQuote {
  id: string;
  from: string;
  to: string;
  amount: number;
  rate: number;
  convertedAmount: number;
  expiresAt: string;
}

export interface RcExchange {
  id: string;
  status: 'pending' | 'completed' | 'failed';
  from: string;
  to: string;
  amount: number;
  rate: number;
  convertedAmount: number;
  createdAt: string;
  completedAt?: string;
}

export async function rcExchangeQuote(from: string, to: string, amount: number): Promise<RcExchangeQuote> {
  const res = await rc.post<RcExchangeQuote>('/exchanges/quote', { from, to, amount });
  return res.data;
}

export async function rcExecuteExchange(quoteId: string): Promise<RcExchange> {
  const res = await rc.post<RcExchange>('/exchanges', { quoteId });
  return res.data;
}
