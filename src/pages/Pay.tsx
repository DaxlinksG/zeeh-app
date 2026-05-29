import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { toast } from '../components/Toast';
import { PinModal } from '../components/PinModal';

type Currency = 'CAD' | 'USD' | 'NGN' | 'GBP' | 'EUR';

const FIELDS: Record<Currency, { key: string; label: string; type?: string; required?: boolean }[]> = {
  NGN: [
    { key: 'bank_id',        label: 'Bank ID (numeric)',  type: 'number', required: true },
    { key: 'account_number', label: 'Account Number',                     required: true },
    { key: 'account_name',   label: 'Account Name',                       required: true },
  ],
  CAD: [
    { key: 'recipient_email', label: 'Recipient Interac Email', type: 'email', required: true },
  ],
  USD: [
    { key: 'bank_name',      label: 'Bank Name',       required: true },
    { key: 'routing_number', label: 'Routing Number',  required: true },
    { key: 'account_number', label: 'Account Number',  required: true },
    { key: 'account_type',   label: 'Account Type (checking/savings)', required: true },
    { key: 'email',          label: 'Recipient Email', type: 'email' },
    { key: 'address',        label: 'Address' },
    { key: 'city',           label: 'City' },
    { key: 'postal_code',    label: 'Postal Code' },
  ],
  GBP: [
    { key: 'account_number', label: 'Account Number', required: true },
    { key: 'sort_code',      label: 'Sort Code',      required: true },
    { key: 'account_name',   label: 'Account Name',   required: true },
  ],
  EUR: [
    { key: 'iban',      label: 'IBAN',      required: true },
    { key: 'swift',     label: 'SWIFT/BIC', required: true },
    { key: 'account_name', label: 'Account Name', required: true },
  ],
};

export default function Pay() {
  const { user } = useAuthStore();
  const needsKyc = user?.kyc_status !== 'approved';
  const [searchParams] = useSearchParams();

  // Pre-select currency if navigated from a balance card
  const urlCurrency = searchParams.get('currency') as Currency | null;
  const [currency,  setCurrency]  = useState<Currency>(
    urlCurrency && Object.keys(FIELDS).includes(urlCurrency) ? urlCurrency : 'NGN'
  );
  const [amount,    setAmount]    = useState('');
  const [reference, setReference] = useState('');
  const [fields,    setFields]    = useState<Record<string, string>>({});
  const [loading,   setLoading]   = useState(false);
  const [done,      setDone]      = useState(false);
  const [showPin,   setShowPin]   = useState(false);
  const [pinError,  setPinError]  = useState('');

  function setField(key: string, val: string) {
    setFields(f => ({ ...f, [key]: val }));
  }

  // Form submit → show PIN modal (validates fields first)
  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPinError('');
    setShowPin(true);
  }

  async function handlePay(pin: string) {
    setLoading(true);
    setPinError('');
    try {
      const body: Record<string, unknown> = {
        amount, currency, pin,
        client_reference: reference || `PAY-${Date.now()}`,
        description: `Bank transfer ${currency} ${amount}`,
        ...fields,
      };
      if (currency === 'NGN' && body.bank_id) body.bank_id = parseInt(body.bank_id as string);
      await api.post('/me/transfer', body);
      setShowPin(false);
      setDone(true);
      toast(`${currency} ${amount} transfer initiated!`);
    } catch (err: unknown) {
      const d = (err as { response?: { data?: { message?: string; code?: string; data?: { available?: string } } } }).response?.data;
      if (d?.code === 'INCORRECT_PIN') { setPinError('Incorrect PIN. Try again.'); return; }
      if (d?.code === 'PIN_LOCKED')    { setPinError(d.message ?? 'PIN locked.'); return; }
      if (d?.code === 'PIN_NOT_SET')   { toast('Set a transaction PIN in Profile → Security first.', 'err'); setShowPin(false); return; }
      setShowPin(false);
      const avail = d?.data?.available;
      toast(avail ? `Insufficient balance. Available: ${currency} ${avail}` : (d?.message ?? 'Transfer failed'), 'err');
    } finally { setLoading(false); }
  }

  if (done) return (
    <div style={{ maxWidth: 480, margin: '4rem auto', textAlign: 'center' }}>
      <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>✅</div>
      <h2 style={{ marginBottom: '.5rem' }}>Transfer Initiated!</h2>
      <p style={{ color: 'var(--muted)', marginBottom: '1.5rem' }}>
        Your {currency} {amount} transfer is being processed. This usually takes 1–3 business days.
      </p>
      <button className="btn btn-primary" onClick={() => { setDone(false); setAmount(''); setFields({}); setReference(''); }}>
        New Transfer
      </button>
    </div>
  );

  return (
    <div style={{ maxWidth: 520 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '.4rem' }}>Bank Transfer</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1.6rem', fontSize: '.9rem' }}>Send money to any bank account.</p>

      {needsKyc && (
        <div style={{ background: 'rgba(255,77,109,.08)', border: '1px solid rgba(255,77,109,.25)', borderRadius: 'var(--radius)', padding: '1rem', marginBottom: '1.2rem', fontSize: '.85rem', color: 'var(--danger)' }}>
          🔒 KYC verification required for bank transfers. <a href="/profile" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Verify now →</a>
        </div>
      )}

      <form className="card" onSubmit={handleFormSubmit}>
        {/* Currency + Amount */}
        <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '.8rem', marginBottom: '1rem' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Currency</label>
            <select value={currency} onChange={e => { setCurrency(e.target.value as Currency); setFields({}); }}>
              {(Object.keys(FIELDS) as Currency[]).map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Amount</label>
            <input type="number" step=".01" min=".01" required value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
          </div>
        </div>

        {/* Dynamic currency fields */}
        {FIELDS[currency].map(f => (
          <div className="form-group" key={f.key}>
            <label>{f.label}</label>
            <input
              type={f.type ?? 'text'}
              required={f.required}
              value={fields[f.key] ?? ''}
              onChange={e => setField(f.key, e.target.value)}
            />
          </div>
        ))}

        <div className="form-group">
          <label>Reference (optional)</label>
          <input value={reference} onChange={e => setReference(e.target.value)} placeholder="Your reference" />
        </div>

        <button className="btn btn-success btn-full" disabled={needsKyc} style={{ marginTop: '.5rem' }}>
          {`Send ${currency}${amount ? ' ' + amount : ''}`}
        </button>
      </form>

      {showPin && (
        <PinModal
          onConfirm={handlePay}
          onCancel={() => { setShowPin(false); setPinError(''); }}
          loading={loading}
          error={pinError}
        />
      )}
    </div>
  );
}
