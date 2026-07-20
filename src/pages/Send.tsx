import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { toast } from '../components/Toast';
import { PinModal } from '../components/PinModal';

// ── Currency config (add entries here to support new corridors) ─────────────
const CURRENCIES = ['CAD', 'NGN'] as const;
type Currency = typeof CURRENCIES[number];

const CURRENCY_META: Record<Currency, { flag: string; symbol: string }> = {
  CAD: { flag: '🇨🇦', symbol: 'CA$' },
  NGN: { flag: '🇳🇬', symbol: '₦'  },
};

// ── Nigerian banks ──────────────────────────────────────────────────────────
const NG_BANKS = [
  { code: '044',    name: 'Access Bank' },
  { code: '050',    name: 'Ecobank Nigeria' },
  { code: '070',    name: 'Fidelity Bank' },
  { code: '011',    name: 'First Bank of Nigeria' },
  { code: '214',    name: 'First City Monument Bank (FCMB)' },
  { code: '058',    name: 'Guaranty Trust Bank (GTBank)' },
  { code: '030',    name: 'Heritage Bank' },
  { code: '082',    name: 'Keystone Bank' },
  { code: '090267', name: 'Kuda Bank' },
  { code: '50515',  name: 'Moniepoint' },
  { code: '100004', name: 'OPay' },
  { code: '100033', name: 'PalmPay' },
  { code: '076',    name: 'Polaris Bank' },
  { code: '101',    name: 'ProvidusBank' },
  { code: '221',    name: 'Stanbic IBTC Bank' },
  { code: '068',    name: 'Standard Chartered Bank' },
  { code: '232',    name: 'Sterling Bank' },
  { code: '032',    name: 'Union Bank of Nigeria' },
  { code: '033',    name: 'United Bank for Africa (UBA)' },
  { code: '215',    name: 'Unity Bank' },
  { code: '035',    name: 'Wema Bank' },
  { code: '057',    name: 'Zenith Bank' },
].sort((a, b) => a.name.localeCompare(b.name));

type Direction = 'CAD_NGN' | 'NGN_CAD';

// ── Types ───────────────────────────────────────────────────────────────────
interface Quote {
  from: Currency;
  to: Currency;
  source_amount: number;
  converted_amount: number;
  cad_amount: number;
  ngn_amount: number;
  raw_rate: number;
  customer_rate: number;
  rate_ngn_per_cad: number; // always NGN per 1 CAD, for rate display
  spread_pct: number;
  expires_at: string;
}

interface SendOrder {
  order_id: string;
  direction?: Direction;
  status: 'awaiting_payment' | 'cad_received' | 'ngn_received' | 'payout_initiated' | 'completed' | 'failed' | 'expired';
  cad_amount: number;
  ngn_amount: number;
  customer_rate: number;
  recipient_name?: string;
  va_account_number?: string;
  va_account_name?: string;
  va_bank_name?: string;
  created_at: string;
  expires_at: string;
  completed_at?: string;
  failure_reason?: string;
  payout_status?: string;
}

interface CadNgnInstructions {
  method: string;
  send_from_email: string;
  send_to_email: string;
  amount_cad: number;
  reference: string;
  note: string;
}

interface NgnCadInstructions {
  method: string;
  account_number: string;
  account_name: string;
  bank_name: string;
  amount_ngn: number;
  reference: string;
  note: string;
}

type Step = 'amount' | 'recipient' | 'email-check' | 'otp' | 'pin' | 'instructions' | 'tracking';

// ── Amount input helpers ────────────────────────────────────────────────────

// Parse a comma-formatted input string to a number
function parseNum(s: string): number {
  return parseFloat(s.replace(/,/g, '')) || 0;
}

// Format a raw string as a typed amount (adds commas, limits decimals)
function fmtInput(raw: string, currency: Currency): string {
  const stripped = raw.replace(/[^0-9.]/g, '');
  if (!stripped) return '';
  const [intRaw, ...decParts] = stripped.split('.');
  const intFormatted = intRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (currency === 'NGN') return intFormatted;
  if (decParts.length > 0) return `${intFormatted}.${decParts.join('').slice(0, 2)}`;
  return intFormatted;
}

// Format a computed number back to an input string
function numToInput(n: number, currency: Currency): string {
  if (!n || n <= 0) return '';
  if (currency === 'NGN') return Math.round(n).toLocaleString('en-US');
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Component ───────────────────────────────────────────────────────────────
export default function Send() {
  const navigate = useNavigate();

  // ── Currency / amount ─────────────────────────────────────────────────
  const [sendCurrency,    setSendCurrency]    = useState<Currency>('CAD');
  const [receiveCurrency, setReceiveCurrency] = useState<Currency>('NGN');
  const [sendInput,       setSendInput]       = useState('');
  const [receiveInput,    setReceiveInput]    = useState('');
  const [lastEdited,      setLastEdited]      = useState<'send' | 'receive'>('send');

  // ── Wizard ────────────────────────────────────────────────────────────
  const [step,           setStep]          = useState<Step>('amount');
  const [quote,          setQuote]         = useState<Quote | null>(null);
  const [quoteLoading,   setQuoteLoading]  = useState(false);
  const [quoteError,     setQuoteError]    = useState('');

  const [recipientAccount, setRecipientAccount] = useState('');
  const [bankCode,         setBankCode]         = useState(NG_BANKS[0].code);
  const [recipientName,    setRecipientName]     = useState('');

  const [verifiedEmails, setVerifiedEmails] = useState<string[]>([]);
  const [senderEmail,    setSenderEmail]    = useState('');
  const [emailLoading,   setEmailLoading]   = useState(false);

  const [otp,        setOtp]       = useState('');
  const [otpLoading, setOtpLoading] = useState(false);

  const [showPin,    setShowPin]    = useState(false);
  const [pinError,   setPinError]   = useState('');
  const [initiating, setInitiating] = useState(false);

  const [orderId,            setOrderId]            = useState('');
  const [cadNgnInstructions, setCadNgnInstructions]  = useState<CadNgnInstructions | null>(null);
  const [ngnCadInstructions, setNgnCadInstructions]  = useState<NgnCadInstructions | null>(null);
  const [order,              setOrder]               = useState<SendOrder | null>(null);
  const [countdown,          setCountdown]           = useState(0);

  const pollRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Derived values ────────────────────────────────────────────────────
  const direction: Direction = sendCurrency === 'CAD' ? 'CAD_NGN' : 'NGN_CAD';
  const sendAmount    = parseNum(sendInput);
  const receiveAmount = parseNum(receiveInput);
  const ngnAmount = sendCurrency === 'NGN' ? sendAmount : receiveAmount;
  const cadAmount = sendCurrency === 'CAD' ? sendAmount : receiveAmount;

  // ── Quote fetch ───────────────────────────────────────────────────────
  const fetchQuote = useCallback(async (
    amount: number, from: Currency, to: Currency, updateField: 'send' | 'receive',
  ) => {
    if (!amount || amount <= 0) return;
    setQuoteLoading(true);
    setQuoteError('');
    try {
      const { data } = await api.get('/me/send/quote', { params: { amount, from, to } });
      const rateNgnPerCad = from === 'CAD' ? data.customer_rate : 1 / data.customer_rate;
      setQuote({
        from, to,
        source_amount: amount,
        converted_amount: data.converted_amount,
        cad_amount: data.cad_amount,
        ngn_amount: data.ngn_amount,
        raw_rate: data.raw_rate,
        customer_rate: data.customer_rate,
        rate_ngn_per_cad: rateNgnPerCad,
        spread_pct: data.spread_pct,
        expires_at: data.expires_at,
      });
      const computed = numToInput(data.converted_amount, to);
      if (updateField === 'receive') setReceiveInput(computed);
      else setSendInput(computed);
    } catch {
      setQuoteError('Could not fetch rate. Check connection.');
    } finally {
      setQuoteLoading(false);
    }
  }, []);

  // Debounce: user typed in "You Send" — compute "Receiver Gets"
  useEffect(() => {
    if (lastEdited !== 'send') return;
    const amt = parseNum(sendInput);
    if (amt <= 0) { setQuote(null); setReceiveInput(''); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchQuote(amt, sendCurrency, receiveCurrency, 'receive'), 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [sendInput, lastEdited, sendCurrency, receiveCurrency, fetchQuote]);

  // Debounce: user typed in "Receiver Gets" — compute "You Send"
  useEffect(() => {
    if (lastEdited !== 'receive') return;
    const amt = parseNum(receiveInput);
    if (amt <= 0) { setQuote(null); setSendInput(''); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchQuote(amt, receiveCurrency, sendCurrency, 'send'), 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [receiveInput, lastEdited, receiveCurrency, sendCurrency, fetchQuote]);

  // Auto-refresh rate every 25 seconds on amount screen
  useEffect(() => {
    if (step !== 'amount') return;
    const interval = setInterval(() => {
      if (lastEdited === 'send') {
        const amt = parseNum(sendInput);
        if (amt > 0) fetchQuote(amt, sendCurrency, receiveCurrency, 'receive');
      } else {
        const amt = parseNum(receiveInput);
        if (amt > 0) fetchQuote(amt, receiveCurrency, sendCurrency, 'send');
      }
    }, 25_000);
    return () => clearInterval(interval);
  }, [step, sendInput, receiveInput, lastEdited, sendCurrency, receiveCurrency, fetchQuote]);

  // ── Load verified emails ──────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'email-check') return;
    api.get('/me/send/emails')
      .then(r => {
        const ready = (r.data.emails ?? [])
          .filter((e: { status: string }) => e.status === 'ready')
          .map((e: { email: string }) => e.email);
        setVerifiedEmails(ready);
        if (ready.length > 0) setSenderEmail(ready[0]);
      })
      .catch(() => {});
  }, [step]);

  // ── Countdown timer ───────────────────────────────────────────────────
  const startCountdown = useCallback((expiresAt: string) => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    const tick = () => {
      const secs = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      setCountdown(secs);
      if (secs === 0) clearInterval(countdownRef.current!);
    };
    tick();
    countdownRef.current = setInterval(tick, 1000);
  }, []);

  // ── Poll order status ─────────────────────────────────────────────────
  const startPolling = useCallback((id: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const { data } = await api.get(`/me/send/${id}`);
        setOrder(data);
        if (['completed', 'failed', 'expired'].includes(data.status)) clearInterval(pollRef.current!);
      } catch {}
    };
    poll();
    pollRef.current = setInterval(poll, 5_000);
  }, []);

  useEffect(() => () => {
    if (pollRef.current)      clearInterval(pollRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (debounceRef.current)  clearTimeout(debounceRef.current);
  }, []);

  // ── Swap currencies ───────────────────────────────────────────────────
  function swapCurrencies() {
    setSendCurrency(receiveCurrency);
    setReceiveCurrency(sendCurrency);
    setSendInput(receiveInput);
    setReceiveInput(sendInput);
    setQuote(null);
    setLastEdited('send');
  }

  // ── Full reset ────────────────────────────────────────────────────────
  function reset() {
    setSendCurrency('CAD');
    setReceiveCurrency('NGN');
    setSendInput('');
    setReceiveInput('');
    setLastEdited('send');
    setStep('amount');
    setQuote(null);
    setQuoteError('');
    setRecipientAccount('');
    setBankCode(NG_BANKS[0].code);
    setRecipientName('');
    setSenderEmail('');
    setOtp('');
    setOrderId('');
    setCadNgnInstructions(null);
    setNgnCadInstructions(null);
    setOrder(null);
    if (pollRef.current)      clearInterval(pollRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }

  // ── Handlers ──────────────────────────────────────────────────────────
  function goToRecipient() {
    if (sendAmount <= 0 || !quote) return toast('Enter an amount', 'err');
    if (direction === 'NGN_CAD' && ngnAmount < 100) return toast('Minimum ₦100', 'err');
    if (direction === 'CAD_NGN' && cadAmount < 1)   return toast('Minimum CAD 1', 'err');
    setStep(direction === 'NGN_CAD' ? 'pin' : 'recipient');
  }

  function goToEmailCheck() {
    if (!recipientAccount.match(/^\d{10}$/)) return toast('Account number must be 10 digits', 'err');
    if (!recipientName.trim())               return toast('Enter account name', 'err');
    setStep('email-check');
  }

  async function handleEmailCheck() {
    if (!senderEmail.includes('@')) return toast('Enter a valid email', 'err');
    setEmailLoading(true);
    try {
      const { data } = await api.post('/me/send/verify-email', { email: senderEmail });
      setStep(data.status === 'ready' ? 'pin' : 'otp');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      toast(msg ?? 'Could not verify email', 'err');
    } finally {
      setEmailLoading(false);
    }
  }

  async function handleOtpConfirm() {
    if (otp.length < 4) return toast('Enter the full OTP', 'err');
    setOtpLoading(true);
    try {
      const { data } = await api.post('/me/send/confirm-email', { email: senderEmail, otp });
      if (data.success) {
        setVerifiedEmails(prev => [...new Set([...prev, senderEmail])]);
        setStep('pin');
      } else {
        toast('Incorrect OTP. Try again.', 'err');
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      toast(msg ?? 'OTP verification failed', 'err');
    } finally {
      setOtpLoading(false);
    }
  }

  async function handleInitiate(pin: string) {
    setInitiating(true);
    setPinError('');
    try {
      if (direction === 'NGN_CAD') {
        const { data } = await api.post('/me/send/receive', { ngn_amount: ngnAmount, pin });
        setOrderId(data.order_id);
        setNgnCadInstructions(data.instructions);
        setShowPin(false);
        setStep('instructions');
        startCountdown(data.expires_at);
        return;
      }
      const bank = NG_BANKS.find(b => b.code === bankCode)!;
      const { data } = await api.post('/me/send/initiate', {
        ngn_amount: ngnAmount,
        sender_email: senderEmail,
        recipient_account: recipientAccount,
        recipient_bank_code: bankCode,
        recipient_bank_name: bank.name,
        recipient_name: recipientName,
        pin,
      });
      setOrderId(data.order_id);
      setCadNgnInstructions(data.instructions);
      setShowPin(false);
      setStep('instructions');
      startCountdown(data.expires_at);
    } catch (err: unknown) {
      const d = (err as { response?: { data?: { message?: string; code?: string } } }).response?.data;
      if (d?.code === 'INCORRECT_PIN') { setPinError('Incorrect PIN. Try again.'); return; }
      if (d?.code === 'PIN_LOCKED')    { setPinError(d.message ?? 'PIN locked. Wait 15 minutes.'); return; }
      if (d?.code === 'PIN_NOT_SET')   { toast('Set a transaction PIN in Profile first.', 'err'); setShowPin(false); return; }
      if (d?.code === 'KYC_REQUIRED')  { toast('Complete KYC before sending money.', 'err'); setShowPin(false); return; }
      setShowPin(false);
      toast(d?.message ?? 'Could not create send order', 'err');
    } finally {
      setInitiating(false);
    }
  }

  function goToTracking() {
    setStep('tracking');
    startPolling(orderId);
  }

  // ── Display formatters ────────────────────────────────────────────────
  const fmtNGN  = (n: number) => '₦' + Math.round(n).toLocaleString('en-NG');
  const fmtCAD  = (n: number) => 'CAD ' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtRate = (r: number) => Math.round(r).toLocaleString('en-NG');

  const countdownMins   = Math.floor(countdown / 60);
  const countdownSecs   = countdown % 60;
  const countdownStr    = `${countdownMins}:${String(countdownSecs).padStart(2, '0')}`;
  const countdownUrgent = countdown < 300 && countdown > 0;

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`, 'ok');
    } catch {
      toast('Copy failed — select and copy manually', 'err');
    }
  }

  // ── Back map ──────────────────────────────────────────────────────────
  const backMap: Partial<Record<Step, Step>> = {
    recipient:     'amount',
    'email-check': 'recipient',
    otp:           'email-check',
    pin:           direction === 'NGN_CAD' ? 'amount' : 'email-check',
  };

  const stepTitles: Record<Step, string> = {
    amount:        'Send Money',
    recipient:     'Recipient Details',
    'email-check': 'Your Interac Email',
    otp:           'Verify Email',
    pin:           'Confirm Transfer',
    instructions:  direction === 'CAD_NGN' ? 'Send via Interac' : 'Nigerian Bank Details',
    tracking:      'Transfer Status',
  };

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 480 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '.8rem', marginBottom: '1.6rem' }}>
        {backMap[step] && (
          <button
            onClick={() => setStep(backMap[step]!)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: '1.3rem', padding: '0 .2rem' }}
          >
            {'←'}
          </button>
        )}
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, margin: 0 }}>{stepTitles[step]}</h1>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          STEP 1 — Amount (dual-input, both editable)
      ══════════════════════════════════════════════════════════════ */}
      {step === 'amount' && (
        <div>

          {/* YOU SEND */}
          <div className="card" style={{ marginBottom: '.5rem' }}>
            <div style={{ fontSize: '.7rem', color: 'var(--muted)', fontWeight: 700, letterSpacing: '.08em', marginBottom: '.6rem' }}>
              YOU SEND
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
              <span style={{ fontSize: '1.5rem', color: 'var(--muted)', fontWeight: 600, flexShrink: 0 }}>
                {CURRENCY_META[sendCurrency].symbol}
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={sendInput}
                onChange={e => {
                  setSendInput(fmtInput(e.target.value, sendCurrency));
                  setLastEdited('send');
                }}
                placeholder="0"
                autoFocus
                style={{
                  flex: 1, background: 'none', border: 'none', outline: 'none',
                  fontSize: '2.2rem', fontWeight: 700, color: 'var(--text)',
                  fontFamily: 'inherit', minWidth: 0,
                }}
              />
              <div style={{
                display: 'flex', alignItems: 'center', gap: '.3rem',
                padding: '.3rem .65rem', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--surface2)',
                flexShrink: 0, fontSize: '.88rem', fontWeight: 700,
              }}>
                <span>{CURRENCY_META[sendCurrency].flag}</span>
                <span>{sendCurrency}</span>
              </div>
            </div>
          </div>

          {/* Swap button */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '.5rem' }}>
            <button
              onClick={swapCurrencies}
              title="Swap currencies"
              style={{
                width: 36, height: 36, borderRadius: '50%',
                border: '1.5px solid var(--border)',
                background: 'var(--surface)', color: 'var(--accent2)',
                cursor: 'pointer', fontSize: '1.1rem', fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {'⇅'}
            </button>
          </div>

          {/* RECEIVER GETS */}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div style={{ fontSize: '.7rem', color: 'var(--muted)', fontWeight: 700, letterSpacing: '.08em', marginBottom: '.6rem' }}>
              RECEIVER GETS
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
              <span style={{ fontSize: '1.5rem', color: 'var(--muted)', fontWeight: 600, flexShrink: 0 }}>
                {CURRENCY_META[receiveCurrency].symbol}
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={quoteLoading && lastEdited === 'send' ? '' : receiveInput}
                onChange={e => {
                  setReceiveInput(fmtInput(e.target.value, receiveCurrency));
                  setLastEdited('receive');
                }}
                placeholder={quoteLoading && lastEdited === 'send' ? 'Calculating…' : '0'}
                style={{
                  flex: 1, background: 'none', border: 'none', outline: 'none',
                  fontSize: '2.2rem', fontWeight: 700,
                  color: quoteLoading && lastEdited === 'send' ? 'var(--muted)' : 'var(--text)',
                  fontFamily: 'inherit', minWidth: 0,
                }}
              />
              <div style={{
                display: 'flex', alignItems: 'center', gap: '.3rem',
                padding: '.3rem .65rem', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--surface2)',
                flexShrink: 0, fontSize: '.88rem', fontWeight: 700,
              }}>
                <span>{CURRENCY_META[receiveCurrency].flag}</span>
                <span>{receiveCurrency}</span>
              </div>
            </div>
          </div>

          {/* Rate info */}
          {quoteError && (
            <div className="card" style={{ color: 'var(--danger)', fontSize: '.88rem', marginBottom: '1rem' }}>
              {quoteError}
            </div>
          )}

          {quote && !quoteLoading && (
            <div className="card" style={{ marginBottom: '1rem', fontSize: '.85rem', padding: '.9rem 1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '.3rem 0' }}>
                <span style={{ color: 'var(--muted)' }}>Exchange rate</span>
                <span style={{ fontWeight: 700 }}>1 CAD = {fmtRate(quote.rate_ngn_per_cad)} NGN</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '.3rem 0', borderTop: '1px solid var(--border)' }}>
                <span style={{ color: 'var(--muted)' }}>Transfer fee</span>
                <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>FREE</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '.3rem 0', borderTop: '1px solid var(--border)' }}>
                <span style={{ color: 'var(--muted)' }}>Spread</span>
                <span>{quote.spread_pct}%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '.3rem 0', borderTop: '1px solid var(--border)' }}>
                <span style={{ color: 'var(--muted)' }}>Rate locked for</span>
                <span>30 min</span>
              </div>
            </div>
          )}

          {/* Delivery method hint */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '.6rem',
            padding: '.7rem 1rem', borderRadius: 10, marginBottom: '1rem',
            background: 'var(--surface)', border: '1px solid var(--border)',
            fontSize: '.83rem', color: 'var(--muted)',
          }}>
            <span style={{ fontSize: '1.1rem' }}>🏦</span>
            {sendCurrency === 'CAD'
              ? <span>Delivered via <strong style={{ color: 'var(--text)' }}>Interac e-Transfer</strong> to Nigerian bank account</span>
              : <span>Nigerian bank transfer credited to your <strong style={{ color: 'var(--text)' }}>CAD wallet</strong></span>
            }
          </div>

          {/* Internal send link */}
          <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigate('/beneficiaries')}
              style={{ fontSize: '.78rem', color: 'var(--muted)' }}
            >
              Send to another Zeeh user instead {'→'}
            </button>
          </div>

          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={!quote || quoteLoading || sendAmount <= 0}
            onClick={goToRecipient}
          >
            Continue {'→'}
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          STEP 2 — Recipient bank details (CAD→NGN only)
      ══════════════════════════════════════════════════════════════ */}
      {step === 'recipient' && (
        <div className="card">
          {/* Transfer summary */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '.8rem 1rem', marginBottom: '1.4rem',
            background: 'rgba(16,217,178,.06)', borderRadius: 10,
            border: '1px solid rgba(16,217,178,.15)',
          }}>
            <div>
              <div style={{ fontSize: '.78rem', color: 'var(--muted)' }}>You pay</div>
              <div style={{ fontWeight: 700 }}>{fmtCAD(cadAmount)}</div>
            </div>
            <div style={{ fontSize: '1.2rem', color: 'var(--muted)' }}>{'→'}</div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '.78rem', color: 'var(--muted)' }}>Recipient gets</div>
              <div style={{ fontWeight: 700 }}>{fmtNGN(ngnAmount)}</div>
            </div>
          </div>

          <div className="form-group">
            <label>Bank</label>
            <select value={bankCode} onChange={e => setBankCode(e.target.value)}>
              {NG_BANKS.map(b => (
                <option key={b.code} value={b.code}>{b.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Account Number</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={10}
              value={recipientAccount}
              onChange={e => setRecipientAccount(e.target.value.replace(/\D/g, ''))}
              placeholder="10-digit account number"
            />
          </div>

          <div className="form-group">
            <label>Account Name</label>
            <input
              type="text"
              value={recipientName}
              onChange={e => setRecipientName(e.target.value)}
              placeholder="Full name as on the account"
            />
            <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginTop: '.25rem' }}>
              Must match the bank account exactly.
            </div>
          </div>

          <button className="btn btn-primary" style={{ width: '100%', marginTop: '.5rem' }} onClick={goToEmailCheck}>
            Continue {'→'}
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          STEP 3 — Interac email verification
      ══════════════════════════════════════════════════════════════ */}
      {step === 'email-check' && (
        <div>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <p style={{ color: 'var(--muted)', fontSize: '.88rem', marginBottom: '1.2rem', lineHeight: 1.6 }}>
              You will send the Interac e-Transfer from this email. We verify it once so we can automatically match your payment.
            </p>

            {verifiedEmails.length > 0 && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ fontSize: '.78rem', color: 'var(--muted)', fontWeight: 600 }}>VERIFIED EMAILS</label>
                {verifiedEmails.map(email => (
                  <button
                    key={email}
                    onClick={() => setSenderEmail(email)}
                    style={{
                      width: '100%', textAlign: 'left', padding: '.75rem 1rem', marginTop: '.4rem',
                      borderRadius: 10,
                      border: senderEmail === email ? '2px solid var(--accent2)' : '1px solid var(--border)',
                      background: senderEmail === email ? 'rgba(16,217,178,.06)' : 'var(--surface)',
                      color: 'var(--text)', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: '.5rem',
                    }}
                  >
                    <span style={{ color: 'var(--accent2)' }}>{senderEmail === email ? '●' : '○'}</span>
                    {email}
                  </button>
                ))}
                <div style={{ textAlign: 'center', margin: '.8rem 0', color: 'var(--muted)', fontSize: '.78rem' }}>
                  or add a new one
                </div>
              </div>
            )}

            <div className="form-group" style={{ marginBottom: '1rem' }}>
              <label>Email you will send from</label>
              <input
                type="email"
                value={senderEmail}
                onChange={e => setSenderEmail(e.target.value)}
                placeholder="your@email.com"
                autoComplete="email"
              />
            </div>

            <button
              className="btn btn-primary"
              style={{ width: '100%' }}
              disabled={emailLoading || !senderEmail.includes('@')}
              onClick={handleEmailCheck}
            >
              {emailLoading ? <><span className="spinner" /> Checking{'…'}</> : 'Continue →'}
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          STEP 4 — OTP
      ══════════════════════════════════════════════════════════════ */}
      {step === 'otp' && (
        <div className="card">
          <p style={{ color: 'var(--muted)', fontSize: '.88rem', marginBottom: '1.4rem', lineHeight: 1.6 }}>
            A verification code was sent to <strong style={{ color: 'var(--text)' }}>{senderEmail}</strong>. Enter it below.
          </p>
          <div className="form-group">
            <label>Verification Code</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={8}
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              autoFocus
              style={{ letterSpacing: '.3em', fontSize: '1.3rem', textAlign: 'center' }}
            />
          </div>
          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={otpLoading || otp.length < 4}
            onClick={handleOtpConfirm}
          >
            {otpLoading ? <><span className="spinner" /> Verifying{'…'}</> : 'Verify →'}
          </button>
          <button
            className="btn btn-ghost"
            style={{ width: '100%', marginTop: '.5rem' }}
            onClick={() => { setOtp(''); setStep('email-check'); }}
          >
            {'←'} Use a different email
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          STEP 5 — PIN + transfer review
      ══════════════════════════════════════════════════════════════ */}
      {step === 'pin' && (
        <>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '.95rem', marginBottom: '1.2rem', color: 'var(--muted)' }}>Review Transfer</h3>

            {direction === 'CAD_NGN' ? (
              <>
                <InfoRow label="You pay"        value={fmtCAD(cadAmount)} />
                <InfoRow label="Recipient gets" value={fmtNGN(ngnAmount)} />
                <InfoRow label="Rate"           value={quote ? `1 CAD = ${fmtRate(quote.rate_ngn_per_cad)} NGN` : '—'} />
                <InfoRow label="Bank"           value={NG_BANKS.find(b => b.code === bankCode)?.name ?? bankCode} />
                <InfoRow label="Account number" value={recipientAccount} mono />
                <InfoRow label="Account name"   value={recipientName} />
                <InfoRow label="Sending from"   value={senderEmail} />
                <InfoRow label="Method"         value="Interac e-Transfer" last />
              </>
            ) : (
              <>
                <InfoRow label="NGN amount"  value={fmtNGN(ngnAmount)} />
                <InfoRow label="You receive" value={fmtCAD(cadAmount)} />
                <InfoRow label="Rate"        value={quote ? `1 CAD = ${fmtRate(quote.rate_ngn_per_cad)} NGN` : '—'} />
                <InfoRow label="Credited to" value="Your CAD wallet" last />
              </>
            )}
          </div>

          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={initiating}
            onClick={() => { setPinError(''); setShowPin(true); }}
          >
            Enter PIN &amp; Confirm
          </button>

          {showPin && (
            <PinModal
              onConfirm={handleInitiate}
              onCancel={() => { setShowPin(false); setPinError(''); }}
              loading={initiating}
              error={pinError}
            />
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════
          STEP 6 — Payment instructions
      ══════════════════════════════════════════════════════════════ */}
      {step === 'instructions' && (cadNgnInstructions || ngnCadInstructions) && (
        <div>
          {/* Rate lock countdown */}
          <div style={{
            textAlign: 'center', padding: '.7rem 1rem', marginBottom: '1rem', borderRadius: 10,
            background: countdownUrgent ? 'rgba(244,63,94,.08)' : 'rgba(16,217,178,.06)',
            border: `1px solid ${countdownUrgent ? 'rgba(244,63,94,.25)' : 'rgba(16,217,178,.18)'}`,
          }}>
            <div style={{ fontSize: '.78rem', color: 'var(--muted)', marginBottom: '.15rem' }}>Rate locked for</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, fontFamily: 'monospace', color: countdownUrgent ? 'var(--danger)' : 'var(--accent2)' }}>
              {countdown === 0 ? 'EXPIRED' : countdownStr}
            </div>
            {countdown === 0 && (
              <div style={{ fontSize: '.78rem', color: 'var(--danger)', marginTop: '.2rem' }}>
                Rate expired. Start a new transfer.
              </div>
            )}
          </div>

          {/* CAD→NGN Interac instructions */}
          {cadNgnInstructions && (
            <div className="card" style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--accent2)', marginBottom: '1rem', letterSpacing: '.05em' }}>
                INTERAC E-TRANSFER INSTRUCTIONS
              </div>
              <InstructionRow
                label="Send to"
                value={cadNgnInstructions.send_to_email}
                onCopy={() => copyText(cadNgnInstructions.send_to_email, 'Email')}
              />
              <InstructionRow
                label="Amount"
                value={`CAD ${cadNgnInstructions.amount_cad.toLocaleString('en-CA', { minimumFractionDigits: 2 })}`}
                onCopy={() => copyText(cadNgnInstructions.amount_cad.toFixed(2), 'Amount')}
                highlight
              />
              <InstructionRow
                label="Reference / Message"
                value={cadNgnInstructions.reference}
                onCopy={() => copyText(cadNgnInstructions.reference, 'Reference')}
                mono
              />
              <InstructionRow
                label="Send from"
                value={cadNgnInstructions.send_from_email}
                last
              />
              <div style={{ marginTop: '1rem', padding: '.8rem 1rem', background: 'rgba(245,158,11,.06)', border: '1px solid rgba(245,158,11,.2)', borderRadius: 10, fontSize: '.8rem', color: 'var(--warn)', lineHeight: 1.5 }}>
                {'⚠️'} Send <strong>exactly</strong>{' '}
                CAD {cadNgnInstructions.amount_cad.toLocaleString('en-CA', { minimumFractionDigits: 2 })}.
                Wrong amounts delay your transfer. Include the reference in the message field.
              </div>
            </div>
          )}

          {/* NGN→CAD virtual account instructions */}
          {ngnCadInstructions && (
            <div className="card" style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--accent2)', marginBottom: '1rem', letterSpacing: '.05em' }}>
                NIGERIAN BANK TRANSFER {'—'} SHARE WITH SENDER
              </div>
              <InstructionRow label="Bank"           value={ngnCadInstructions.bank_name}           onCopy={() => copyText(ngnCadInstructions.bank_name, 'Bank')} />
              <InstructionRow label="Account Number" value={ngnCadInstructions.account_number}      onCopy={() => copyText(ngnCadInstructions.account_number, 'Account Number')} highlight mono />
              <InstructionRow label="Account Name"   value={ngnCadInstructions.account_name}        onCopy={() => copyText(ngnCadInstructions.account_name, 'Account Name')} />
              <InstructionRow label="Amount"         value={fmtNGN(ngnCadInstructions.amount_ngn)}  onCopy={() => copyText(String(ngnCadInstructions.amount_ngn), 'Amount')} />
              <InstructionRow label="Reference"      value={ngnCadInstructions.reference}           onCopy={() => copyText(ngnCadInstructions.reference, 'Reference')} mono last />
              <div style={{ marginTop: '1rem', padding: '.8rem 1rem', background: 'rgba(16,217,178,.06)', border: '1px solid rgba(16,217,178,.2)', borderRadius: 10, fontSize: '.8rem', color: 'var(--accent2)', lineHeight: 1.5 }}>
                Share these details with the person sending from Nigeria. Once they transfer, your CAD will appear in your wallet automatically.
              </div>
            </div>
          )}

          <button className="btn btn-primary" style={{ width: '100%', marginBottom: '.6rem' }} onClick={goToTracking}>
            {cadNgnInstructions ? "I have sent the Interac — Track →" : "Waiting for Nigerian Transfer — Track →"}
          </button>
          <button className="btn btn-ghost" style={{ width: '100%' }} onClick={reset}>
            Cancel &amp; Start Over
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          STEP 7 — Transfer tracking
      ══════════════════════════════════════════════════════════════ */}
      {step === 'tracking' && (
        <div>
          <div className="card" style={{ textAlign: 'center', marginBottom: '1rem' }}>
            <StatusDisplay order={order} />
          </div>

          {order && (
            <div className="card" style={{ marginBottom: '1rem' }}>
              <InfoRow label="Order ID" value={order.order_id} mono />
              {order.direction === 'NGN_CAD' ? (
                <>
                  <InfoRow label="NGN sent"    value={fmtNGN(order.ngn_amount)} />
                  <InfoRow label="CAD credited" value={fmtCAD(order.cad_amount)} />
                  <InfoRow label="Credited to"  value="Your CAD wallet" last />
                </>
              ) : (
                <>
                  <InfoRow label="You paid"       value={fmtCAD(order.cad_amount)} />
                  <InfoRow label="Recipient gets"  value={fmtNGN(order.ngn_amount)} />
                  <InfoRow label="Account"         value={recipientAccount} mono />
                  <InfoRow label="Account name"    value={order.recipient_name ?? recipientName} last />
                </>
              )}
            </div>
          )}

          {order?.status === 'completed' && (
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={reset}>
              Send Again
            </button>
          )}
          {(order?.status === 'failed' || order?.status === 'expired') && (
            <button className="btn btn-ghost" style={{ width: '100%' }} onClick={reset}>
              Start New Transfer
            </button>
          )}
          {(!order || ['awaiting_payment', 'cad_received', 'ngn_received', 'payout_initiated'].includes(order.status)) && (
            <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '.8rem', marginTop: '1rem' }}>
              This page updates automatically every 5 seconds.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function InfoRow({ label, value, mono, last }: { label: string; value: string; mono?: boolean; last?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '.5rem 0',
      borderBottom: last ? 'none' : '1px solid var(--border)',
    }}>
      <span style={{ color: 'var(--muted)', fontSize: '.83rem', flexShrink: 0, marginRight: '.5rem' }}>{label}</span>
      <span style={{ fontSize: '.83rem', fontFamily: mono ? 'monospace' : undefined, textAlign: 'right', wordBreak: 'break-all' }}>
        {value}
      </span>
    </div>
  );
}

function InstructionRow({
  label, value, onCopy, highlight, mono, last,
}: {
  label: string; value: string; onCopy?: () => void;
  highlight?: boolean; mono?: boolean; last?: boolean;
}) {
  return (
    <div style={{ padding: '.75rem 0', borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <div style={{ fontSize: '.75rem', color: 'var(--muted)', fontWeight: 600, marginBottom: '.2rem' }}>{label}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.5rem' }}>
        <span style={{
          fontSize: highlight ? '1.15rem' : '.9rem',
          fontWeight: highlight ? 700 : 500,
          fontFamily: mono ? 'monospace' : undefined,
          wordBreak: 'break-all',
        }}>
          {value}
        </span>
        {onCopy && (
          <button
            onClick={onCopy}
            style={{
              background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '.25rem .6rem', cursor: 'pointer',
              color: 'var(--accent2)', fontSize: '.75rem', fontWeight: 600, flexShrink: 0,
            }}
          >
            Copy
          </button>
        )}
      </div>
    </div>
  );
}

type OrderStatus = 'awaiting_payment' | 'cad_received' | 'ngn_received' | 'payout_initiated' | 'completed' | 'failed' | 'expired';

const STATUS_CONFIG: Record<OrderStatus, { icon: string; label: string; sub: string; color: string }> = {
  awaiting_payment: { icon: '⏳', label: 'Waiting for payment',     sub: 'Send money using the instructions above.',    color: 'var(--warn)' },
  cad_received:     { icon: '✅', label: 'CAD received',            sub: 'Converting and sending to recipient…',   color: 'var(--accent2)' },
  ngn_received:     { icon: '✅', label: 'NGN received',            sub: 'Exchanging to CAD and crediting your wallet…', color: 'var(--accent2)' },
  payout_initiated: { icon: '🚀', label: 'Processing',        sub: 'Funds are on the way.',                       color: 'var(--accent2)' },
  completed:        { icon: '🎉', label: 'Transfer complete!', sub: 'Funds delivered successfully.',               color: 'var(--accent2)' },
  failed:           { icon: '❌', label: 'Transfer failed',         sub: 'Something went wrong. Contact support.',      color: 'var(--danger)' },
  expired:          { icon: '⌛', label: 'Rate expired',            sub: 'Transfer window closed. Start a new one.',    color: 'var(--muted)' },
};

function StatusDisplay({ order }: { order: { order_id: string; direction?: Direction; status: OrderStatus; cad_amount: number; ngn_amount: number; customer_rate: number; recipient_name?: string; va_account_number?: string; va_account_name?: string; va_bank_name?: string; created_at: string; expires_at: string; completed_at?: string; failure_reason?: string; payout_status?: string } | null }) {
  if (!order) {
    return (
      <div style={{ padding: '2rem', color: 'var(--muted)' }}>
        <span className="spinner spinner-lg" />
        <div style={{ marginTop: '1rem' }}>Checking status{'…'}</div>
      </div>
    );
  }
  const cfg = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.awaiting_payment;
  return (
    <div style={{ padding: '1.5rem 1rem' }}>
      <div style={{ fontSize: '3rem', marginBottom: '.75rem' }}>{cfg.icon}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 700, color: cfg.color, marginBottom: '.4rem' }}>{cfg.label}</div>
      <div style={{ fontSize: '.85rem', color: 'var(--muted)', lineHeight: 1.5 }}>{cfg.sub}</div>
      {order.failure_reason && (
        <div style={{ marginTop: '.75rem', fontSize: '.8rem', color: 'var(--danger)', background: 'rgba(244,63,94,.08)', padding: '.6rem .9rem', borderRadius: 8 }}>
          {order.failure_reason}
        </div>
      )}
      {!['failed', 'expired'].includes(order.status) && (
        <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'center', marginTop: '1.2rem' }}>
          {(['awaiting_payment', 'payout_initiated', 'completed'] as OrderStatus[]).map(s => (
            <div
              key={s}
              style={{
                width: 8, height: 8, borderRadius: '50%', transition: 'background .3s',
                background: (['awaiting_payment', 'payout_initiated', 'completed'] as OrderStatus[]).indexOf(s)
                  <= (['awaiting_payment', 'cad_received', 'ngn_received', 'payout_initiated', 'completed'] as OrderStatus[]).indexOf(order.status)
                  ? cfg.color : 'var(--border)',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
