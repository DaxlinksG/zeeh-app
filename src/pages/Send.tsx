import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { toast } from '../components/Toast';
import { PinModal } from '../components/PinModal';

// ── Nigerian banks ─────────────────────────────────────────────────────────
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

// ── Types ──────────────────────────────────────────────────────────────────
interface Quote {
  from: string;
  to: string;
  cad_amount: number;
  ngn_amount: number;
  raw_rate: number;
  customer_rate: number;
  spread_pct: number;
  expires_at: string;
}

interface SendOrder {
  order_id: string;
  status: 'awaiting_payment' | 'cad_received' | 'payout_initiated' | 'completed' | 'failed' | 'expired';
  cad_amount: number;
  ngn_amount: number;
  customer_rate: number;
  recipient_name: string;
  created_at: string;
  expires_at: string;
  completed_at?: string;
  failure_reason?: string;
  payout_status?: string;
}

interface Instructions {
  method: string;
  send_from_email: string;
  send_to_email: string;
  amount_cad: number;
  reference: string;
  note: string;
}

type Step =
  | 'amount'
  | 'recipient'
  | 'email-check'
  | 'otp'
  | 'pin'
  | 'instructions'
  | 'tracking';

// ── Component ──────────────────────────────────────────────────────────────
export default function Send() {
  const navigate = useNavigate();

  const [step,           setStep]          = useState<Step>('amount');
  const [ngnInput,       setNgnInput]      = useState('');
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

  const [showPin,   setShowPin]   = useState(false);
  const [pinError,  setPinError]  = useState('');
  const [initiating, setInitiating] = useState(false);

  const [orderId,       setOrderId]      = useState('');
  const [instructions,  setInstructions] = useState<Instructions | null>(null);
  const [order,         setOrder]        = useState<SendOrder | null>(null);
  const [countdown,     setCountdown]    = useState(0);

  const pollRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Quote fetch ────────────────────────────────────────────────────────
  const fetchQuote = useCallback(async (ngn: number) => {
    if (!ngn || ngn <= 0) return;
    setQuoteLoading(true);
    setQuoteError('');
    try {
      // Quote endpoint takes CAD amount; we send 1 CAD to get the rate, then compute
      const { data } = await api.get('/me/send/quote', { params: { amount: 1 } });
      const rate: number = data.customer_rate;
      const cad = parseFloat((ngn / rate).toFixed(2));
      setQuote({
        from: 'CAD', to: 'NGN',
        ngn_amount: ngn, cad_amount: cad,
        raw_rate: data.raw_rate, customer_rate: rate,
        spread_pct: data.spread_pct,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
    } catch {
      setQuoteError('Could not fetch rate. Check connection.');
    } finally {
      setQuoteLoading(false);
    }
  }, []);

  // Debounce quote fetching as user types
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const ngn = parseFloat(ngnInput);
    if (!ngn || ngn <= 0) { setQuote(null); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchQuote(ngn), 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [ngnInput, fetchQuote]);

  // Auto-refresh rate every 25 seconds while on amount screen
  useEffect(() => {
    if (step !== 'amount') return;
    const interval = setInterval(() => {
      const ngn = parseFloat(ngnInput);
      if (ngn > 0) fetchQuote(ngn);
    }, 25_000);
    return () => clearInterval(interval);
  }, [step, ngnInput, fetchQuote]);

  // ── Load verified emails ───────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'email-check') return;
    api.get('/me/send/emails')
      .then(r => {
        const ready = (r.data.emails ?? [])
          .filter((e: { status: string; email: string }) => e.status === 'ready')
          .map((e: { email: string }) => e.email);
        setVerifiedEmails(ready);
        if (ready.length > 0) setSenderEmail(ready[0]);
      })
      .catch(() => {});
  }, [step]);

  // ── Countdown timer ────────────────────────────────────────────────────
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

  // ── Poll order status ──────────────────────────────────────────────────
  const startPolling = useCallback((id: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const { data } = await api.get(`/me/send/${id}`);
        setOrder(data);
        if (['completed', 'failed', 'expired'].includes(data.status)) {
          clearInterval(pollRef.current!);
        }
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

  // ── Handlers ───────────────────────────────────────────────────────────
  function goToRecipient() {
    const ngn = parseFloat(ngnInput);
    if (!ngn || ngn < 100) return toast('Enter at least ₦100', 'err');
    if (!quote)            return toast('Wait for rate to load', 'err');
    setStep('recipient');
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
      if (data.status === 'ready') {
        setStep('pin');
      } else {
        setStep('otp');
      }
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
      const bank = NG_BANKS.find(b => b.code === bankCode)!;
      const ngn = parseFloat(ngnInput);
      const { data } = await api.post('/me/send/initiate', {
        ngn_amount: ngn,
        sender_email: senderEmail,
        recipient_account: recipientAccount,
        recipient_bank_code: bankCode,
        recipient_bank_name: bank.name,
        recipient_name: recipientName,
        pin,
      });
      setOrderId(data.order_id);
      setInstructions(data.instructions);
      setShowPin(false);
      setStep('instructions');
      startCountdown(data.expires_at);
    } catch (err: unknown) {
      const d = (err as { response?: { data?: { message?: string; code?: string } } }).response?.data;
      if (d?.code === 'INCORRECT_PIN') { setPinError('Incorrect PIN. Try again.'); return; }
      if (d?.code === 'PIN_LOCKED')    { setPinError(d.message ?? 'PIN locked. Wait 15 minutes.'); return; }
      if (d?.code === 'PIN_NOT_SET')   { toast('Set a transaction PIN in Profile → Security first.', 'err'); setShowPin(false); return; }
      if (d?.code === 'KYC_REQUIRED')  { toast('Complete KYC before sending money internationally.', 'err'); setShowPin(false); return; }
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

  function reset() {
    setStep('amount');
    setNgnInput('');
    setQuote(null);
    setRecipientAccount('');
    setBankCode(NG_BANKS[0].code);
    setRecipientName('');
    setSenderEmail('');
    setOtp('');
    setOrderId('');
    setInstructions(null);
    setOrder(null);
    if (pollRef.current)      clearInterval(pollRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  const fmtNGN = (n: number) => '₦' + n.toLocaleString('en-NG');
  const fmtCAD = (n: number) => 'CAD ' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtRate = (r: number) => '₦' + Math.round(r).toLocaleString('en-NG');

  const countdownMins = Math.floor(countdown / 60);
  const countdownSecs = countdown % 60;
  const countdownStr  = `${countdownMins}:${String(countdownSecs).padStart(2, '0')}`;
  const countdownUrgent = countdown < 300 && countdown > 0;

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`, 'ok');
    } catch {
      toast('Copy failed — select and copy manually', 'err');
    }
  }

  // ── Back button map ────────────────────────────────────────────────────
  const backMap: Partial<Record<Step, Step>> = {
    recipient:     'amount',
    'email-check': 'recipient',
    otp:           'email-check',
    pin:           'email-check',
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 480 }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '.8rem', marginBottom: '1.6rem' }}>
        {backMap[step] && (
          <button
            onClick={() => setStep(backMap[step]!)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: '1.3rem', padding: '0 .2rem' }}
          >←</button>
        )}
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, margin: 0 }}>
          {step === 'amount'       && 'Send to Nigeria'}
          {step === 'recipient'    && 'Recipient Details'}
          {step === 'email-check'  && 'Your Interac Email'}
          {step === 'otp'          && 'Verify Email'}
          {step === 'pin'          && 'Confirm Transfer'}
          {step === 'instructions' && 'Payment Instructions'}
          {step === 'tracking'     && 'Transfer Status'}
        </h1>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          STEP 1 — Amount
      ══════════════════════════════════════════════════════════════ */}
      {step === 'amount' && (
        <div>
          {/* NGN input */}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '.78rem', color: 'var(--muted)', fontWeight: 600, marginBottom: '.4rem', display: 'block' }}>
              AMOUNT RECIPIENT RECEIVES
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
              <span style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--muted)' }}>₦</span>
              <input
                type="number"
                min="100"
                step="1000"
                value={ngnInput}
                onChange={e => setNgnInput(e.target.value)}
                placeholder="0"
                autoFocus
                style={{
                  flex: 1, background: 'none', border: 'none', outline: 'none',
                  fontSize: '2rem', fontWeight: 700, color: 'var(--text)',
                  fontFamily: 'inherit',
                }}
              />
              <span style={{ fontSize: '.85rem', color: 'var(--muted)', fontWeight: 600 }}>NGN</span>
            </div>
          </div>

          {/* Quote result */}
          {quoteLoading && (
            <div className="card" style={{ textAlign: 'center', padding: '1.2rem', color: 'var(--muted)' }}>
              <span className="spinner" /> &nbsp;Getting live rate…
            </div>
          )}

          {quoteError && (
            <div className="card" style={{ color: 'var(--danger)', fontSize: '.88rem', padding: '1rem' }}>
              {quoteError}
            </div>
          )}

          {quote && !quoteLoading && (
            <div className="card" style={{ marginBottom: '1rem' }}>
              {/* You pay */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.8rem' }}>
                <span style={{ color: 'var(--muted)', fontSize: '.85rem' }}>You send (via Interac)</span>
                <span style={{ fontWeight: 700, fontSize: '1.1rem' }}>{fmtCAD(quote.cad_amount)}</span>
              </div>
              {/* Rate row */}
              <div style={{
                padding: '.7rem 1rem',
                background: 'rgba(16,217,178,.06)',
                border: '1px solid rgba(16,217,178,.18)',
                borderRadius: 10,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span style={{ fontSize: '.82rem', color: 'var(--accent2)', fontWeight: 600 }}>Rate</span>
                <span style={{ fontSize: '.88rem', fontWeight: 700 }}>1 CAD = {fmtRate(quote.customer_rate)} NGN</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '.7rem' }}>
                <span style={{ color: 'var(--muted)', fontSize: '.78rem' }}>Spread</span>
                <span style={{ fontSize: '.78rem' }}>{quote.spread_pct}%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '.2rem' }}>
                <span style={{ color: 'var(--muted)', fontSize: '.78rem' }}>Rate lock</span>
                <span style={{ fontSize: '.78rem' }}>30 minutes</span>
              </div>
            </div>
          )}

          {/* Internal send link */}
          <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigate('/beneficiaries')}
              style={{ fontSize: '.78rem', color: 'var(--muted)' }}
            >
              Send to another Zeeh user instead →
            </button>
          </div>

          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={!quote || quoteLoading || parseFloat(ngnInput) < 100}
            onClick={goToRecipient}
          >
            Continue →
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          STEP 2 — Recipient
      ══════════════════════════════════════════════════════════════ */}
      {step === 'recipient' && (
        <div className="card">
          {/* Transfer summary */}
          <div style={{
            padding: '.8rem 1rem', marginBottom: '1.4rem',
            background: 'rgba(16,217,178,.06)', borderRadius: 10,
            border: '1px solid rgba(16,217,178,.15)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div style={{ fontSize: '.78rem', color: 'var(--muted)' }}>Sending</div>
              <div style={{ fontWeight: 700 }}>{fmtNGN(parseFloat(ngnInput))}</div>
            </div>
            <div style={{ fontSize: '1.2rem', color: 'var(--muted)' }}>→</div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '.78rem', color: 'var(--muted)' }}>You pay</div>
              <div style={{ fontWeight: 700 }}>{quote && fmtCAD(quote.cad_amount)}</div>
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
              Make sure this matches the bank account exactly.
            </div>
          </div>

          <button className="btn btn-primary" style={{ width: '100%', marginTop: '.5rem' }} onClick={goToEmailCheck}>
            Continue →
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          STEP 3 — Interac email check
      ══════════════════════════════════════════════════════════════ */}
      {step === 'email-check' && (
        <div>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <p style={{ color: 'var(--muted)', fontSize: '.88rem', marginBottom: '1.2rem', lineHeight: 1.6 }}>
              You'll send the Interac e-Transfer from this email. We need to verify it once so we can automatically match your payment.
            </p>

            {/* Previously verified emails */}
            {verifiedEmails.length > 0 && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ fontSize: '.78rem', color: 'var(--muted)', fontWeight: 600 }}>VERIFIED EMAILS</label>
                {verifiedEmails.map(email => (
                  <button
                    key={email}
                    onClick={() => setSenderEmail(email)}
                    style={{
                      width: '100%', textAlign: 'left', padding: '.75rem 1rem',
                      marginTop: '.4rem', borderRadius: 10,
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
                <div style={{ textAlign: 'center', margin: '.8rem 0', color: 'var(--muted)', fontSize: '.78rem' }}>or add a new one</div>
              </div>
            )}

            <div className="form-group" style={{ marginBottom: '1rem' }}>
              <label>Email you'll send from</label>
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
              {emailLoading ? <><span className="spinner" /> Checking…</> : 'Continue →'}
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
            {otpLoading ? <><span className="spinner" /> Verifying…</> : 'Verify →'}
          </button>

          <button
            className="btn btn-ghost"
            style={{ width: '100%', marginTop: '.5rem' }}
            onClick={() => { setOtp(''); setStep('email-check'); }}
          >
            ← Use a different email
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          STEP 5 — PIN (confirm transfer)
      ══════════════════════════════════════════════════════════════ */}
      {step === 'pin' && (
        <>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '.95rem', marginBottom: '1.2rem', color: 'var(--muted)' }}>Review Transfer</h3>

            <InfoRow label="You pay"         value={quote ? fmtCAD(quote.cad_amount) : '—'} />
            <InfoRow label="Recipient gets"  value={fmtNGN(parseFloat(ngnInput))} />
            <InfoRow label="Rate"            value={quote ? `1 CAD = ${fmtRate(quote.customer_rate)} NGN` : '—'} />
            <InfoRow label="Bank"            value={NG_BANKS.find(b => b.code === bankCode)?.name ?? bankCode} />
            <InfoRow label="Account number"  value={recipientAccount} mono />
            <InfoRow label="Account name"    value={recipientName} />
            <InfoRow label="Sending from"    value={senderEmail} />
            <InfoRow label="Method"          value="Interac e-Transfer" last />
          </div>

          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={initiating}
            onClick={() => { setPinError(''); setShowPin(true); }}
          >
            Enter PIN & Confirm
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
          STEP 6 — Payment Instructions
      ══════════════════════════════════════════════════════════════ */}
      {step === 'instructions' && instructions && (
        <div>
          {/* Rate lock countdown */}
          <div style={{
            textAlign: 'center', padding: '.7rem 1rem', marginBottom: '1rem',
            borderRadius: 10,
            background: countdownUrgent ? 'rgba(244,63,94,.08)' : 'rgba(16,217,178,.06)',
            border: `1px solid ${countdownUrgent ? 'rgba(244,63,94,.25)' : 'rgba(16,217,178,.18)'}`,
          }}>
            <div style={{ fontSize: '.78rem', color: 'var(--muted)', marginBottom: '.15rem' }}>Rate locked for</div>
            <div style={{
              fontSize: '1.5rem', fontWeight: 700, fontFamily: 'monospace',
              color: countdownUrgent ? 'var(--danger)' : 'var(--accent2)',
            }}>
              {countdown === 0 ? 'EXPIRED' : countdownStr}
            </div>
            {countdown === 0 && (
              <div style={{ fontSize: '.78rem', color: 'var(--danger)', marginTop: '.2rem' }}>
                Rate expired. Start a new transfer.
              </div>
            )}
          </div>

          {/* Instructions card */}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--accent2)', marginBottom: '1rem', letterSpacing: '.05em' }}>
              INTERAC E-TRANSFER INSTRUCTIONS
            </div>

            <InstructionRow
              label="Send to"
              value={instructions.send_to_email}
              onCopy={() => copyText(instructions.send_to_email, 'Email')}
            />
            <InstructionRow
              label="Amount"
              value={`CAD ${instructions.amount_cad.toFixed(2)}`}
              onCopy={() => copyText(instructions.amount_cad.toFixed(2), 'Amount')}
              highlight
            />
            <InstructionRow
              label="Reference / Message"
              value={instructions.reference}
              onCopy={() => copyText(instructions.reference, 'Reference')}
              mono
            />
            <InstructionRow
              label="Send from"
              value={instructions.send_from_email}
              last
            />

            <div style={{
              marginTop: '1rem', padding: '.8rem 1rem',
              background: 'rgba(245,158,11,.06)', border: '1px solid rgba(245,158,11,.2)',
              borderRadius: 10, fontSize: '.8rem', color: 'var(--warn)', lineHeight: 1.5,
            }}>
              ⚠️ Send <strong>exactly</strong> CAD {instructions.amount_cad.toFixed(2)}. Wrong amounts delay your transfer. Include the reference in the message field.
            </div>
          </div>

          <button
            className="btn btn-primary"
            style={{ width: '100%', marginBottom: '.6rem' }}
            onClick={goToTracking}
          >
            I've sent the Interac — Track Transfer →
          </button>
          <button className="btn btn-ghost" style={{ width: '100%' }} onClick={reset}>
            Cancel & Start Over
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          STEP 7 — Tracking
      ══════════════════════════════════════════════════════════════ */}
      {step === 'tracking' && (
        <div>
          {/* Status card */}
          <div className="card" style={{ textAlign: 'center', marginBottom: '1rem' }}>
            <StatusDisplay order={order} />
          </div>

          {/* Details */}
          {order && (
            <div className="card" style={{ marginBottom: '1rem' }}>
              <InfoRow label="Order ID"       value={order.order_id} mono />
              <InfoRow label="You paid"        value={fmtCAD(order.cad_amount)} />
              <InfoRow label="Recipient gets"  value={fmtNGN(order.ngn_amount)} />
              <InfoRow label="Account"         value={recipientAccount} mono />
              <InfoRow label="Account name"    value={recipientName} last />
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

          {(!order || ['awaiting_payment', 'cad_received', 'payout_initiated'].includes(order.status)) && (
            <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '.8rem', marginTop: '1rem' }}>
              This page updates automatically every 5 seconds.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

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
    <div style={{
      padding: '.75rem 0',
      borderBottom: last ? 'none' : '1px solid var(--border)',
    }}>
      <div style={{ fontSize: '.75rem', color: 'var(--muted)', fontWeight: 600, marginBottom: '.2rem' }}>{label}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.5rem' }}>
        <span style={{
          fontSize: highlight ? '1.15rem' : '.9rem',
          fontWeight: highlight ? 700 : 500,
          fontFamily: mono ? 'monospace' : undefined,
          color: highlight ? 'var(--text)' : 'var(--text)',
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

type OrderStatus = 'awaiting_payment' | 'cad_received' | 'payout_initiated' | 'completed' | 'failed' | 'expired';

const STATUS_CONFIG: Record<OrderStatus, { icon: string; label: string; sub: string; color: string }> = {
  awaiting_payment:  { icon: '⏳', label: 'Waiting for your Interac',   sub: 'Send your Interac e-Transfer now.',              color: 'var(--warn)' },
  cad_received:      { icon: '✅', label: 'Payment received',            sub: 'Converting and sending to recipient…',           color: 'var(--accent2)' },
  payout_initiated:  { icon: '🚀', label: 'Sending to recipient',        sub: 'Funds are on the way to the bank account.',      color: 'var(--accent2)' },
  completed:         { icon: '🎉', label: 'Transfer complete!',          sub: 'Funds delivered to the recipient's account.',   color: 'var(--accent2)' },
  failed:            { icon: '❌', label: 'Transfer failed',             sub: 'Something went wrong. Contact support.',         color: 'var(--danger)' },
  expired:           { icon: '⌛', label: 'Rate expired',               sub: 'You didn't send in time. Start a new transfer.', color: 'var(--muted)' },
};

function StatusDisplay({ order }: { order: SendOrder | null }) {
  if (!order) {
    return (
      <div style={{ padding: '2rem', color: 'var(--muted)' }}>
        <span className="spinner spinner-lg" />
        <div style={{ marginTop: '1rem' }}>Checking status…</div>
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

      {/* Progress dots */}
      {!['failed', 'expired'].includes(order.status) && (
        <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'center', marginTop: '1.2rem' }}>
          {(['awaiting_payment', 'cad_received', 'payout_initiated', 'completed'] as OrderStatus[]).map(s => (
            <div
              key={s}
              style={{
                width: 8, height: 8, borderRadius: '50%',
                background: (['awaiting_payment', 'cad_received', 'payout_initiated', 'completed'] as OrderStatus[]).indexOf(s)
                  <= (['awaiting_payment', 'cad_received', 'payout_initiated', 'completed'] as OrderStatus[]).indexOf(order.status)
                  ? cfg.color : 'var(--border)',
                transition: 'background .3s',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
