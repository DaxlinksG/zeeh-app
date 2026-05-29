import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { toast } from '../components/Toast';
import { PinModal } from '../components/PinModal';

interface Beneficiary {
  beneficiary_id: string;
  email:          string;
  first_name:     string;
  last_name:      string;
}

const CURRENCIES = ['CAD', 'USD', 'NGN', 'GBP', 'EUR'];

export default function Send() {
  const navigate = useNavigate();
  const [step,        setStep]        = useState<'pick' | 'amount' | 'confirm' | 'done'>('pick');
  const [showPin,     setShowPin]     = useState(false);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [loadingBen,  setLoadingBen]  = useState(true);
  const [recipient,   setRecipient]   = useState<Beneficiary | null>(null);
  const [currency,    setCurrency]    = useState('CAD');
  const [amount,      setAmount]      = useState('');
  const [note,        setNote]        = useState('');
  const [ref,         setRef]         = useState('');
  const [loading,     setLoading]     = useState(false);
  const [pinError,    setPinError]    = useState('');
  const [available,   setAvailable]   = useState<string | null>(null);

  // Fetch balance when amount step is active or currency changes
  useEffect(() => {
    if (step !== 'amount') return;
    setAvailable(null);
    api.get(`/me/balance/${currency}`)
      .then(r => setAvailable(r.data.data?.available ?? '0'))
      .catch(() => setAvailable(null));
  }, [step, currency]);

  const isInsufficient = available !== null && amount !== '' && parseFloat(amount) > parseFloat(available);

  useEffect(() => {
    api.get('/me/beneficiaries')
      .then(r => setBeneficiaries(r.data.data?.beneficiaries ?? []))
      .catch(() => toast('Failed to load beneficiaries', 'err'))
      .finally(() => setLoadingBen(false));
  }, []);

  async function handleSend(pin: string) {
    setLoading(true);
    setPinError('');
    try {
      const { data } = await api.post('/me/send', {
        recipient_email: recipient!.email, currency, amount,
        note: note || undefined, pin,
      });
      setRef(data.data.reference);
      setShowPin(false);
      setStep('done');
      toast(`Sent ${currency} ${amount} to ${recipient!.first_name}!`);
    } catch (err: unknown) {
      const d = (err as { response?: { data?: { message?: string; code?: string; data?: { available?: string } } } }).response?.data;
      if (d?.code === 'INCORRECT_PIN') { setPinError('Incorrect PIN. Try again.'); return; }
      if (d?.code === 'PIN_LOCKED')    { setPinError(d.message ?? 'PIN locked. Wait 15 minutes.'); return; }
      if (d?.code === 'PIN_NOT_SET')   { toast('Set a transaction PIN in Profile → Security first.', 'err'); setShowPin(false); return; }
      setShowPin(false);
      const available = d?.data?.available;
      toast(available
        ? `Insufficient balance. Available: ${currency} ${available}`
        : (d?.message ?? 'Send failed'), 'err');
    } finally { setLoading(false); }
  }

  if (step === 'done') return (
    <div style={{ maxWidth: 480, margin: '4rem auto', textAlign: 'center' }}>
      <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>✅</div>
      <h2 style={{ marginBottom: '.5rem' }}>Money Sent!</h2>
      <p style={{ color: 'var(--muted)', marginBottom: '1.5rem' }}>
        {currency} {amount} sent to {recipient?.first_name} {recipient?.last_name}
      </p>
      <div className="card" style={{ textAlign: 'left', marginBottom: '1.5rem' }}>
        <InfoRow label="Reference" value={ref} mono />
        <InfoRow label="Amount"    value={`${currency} ${amount}`} />
        <InfoRow label="To"        value={`${recipient?.first_name} ${recipient?.last_name} (${recipient?.email})`} />
        {note && <InfoRow label="Note" value={note} />}
      </div>
      <button className="btn btn-primary" onClick={() => { setStep('pick'); setRecipient(null); setAmount(''); setNote(''); }}>
        Send Again
      </button>
    </div>
  );

  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '1.6rem' }}>Send Money</h1>

      {/* ── Step 1: Pick beneficiary ── */}
      {step === 'pick' && (
        loadingBen ? (
          <div style={{ textAlign: 'center', padding: '3rem' }}><span className="spinner spinner-lg" /></div>
        ) : beneficiaries.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--muted)' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '.8rem' }}>👥</div>
            <div style={{ fontWeight: 500, marginBottom: '.5rem' }}>No beneficiaries yet</div>
            <div style={{ fontSize: '.84rem', marginBottom: '1.5rem' }}>
              Add someone as a beneficiary first before sending them money.
            </div>
            <button className="btn btn-primary" onClick={() => navigate('/beneficiaries')}>
              Add Beneficiary →
            </button>
          </div>
        ) : (
          <>
            <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: '.8rem' }}>
              {beneficiaries.map((b, i) => (
                <button
                  key={b.beneficiary_id}
                  onClick={() => { setRecipient(b); setStep('amount'); }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: '1rem',
                    padding: '1rem 1.2rem',
                    borderBottom: i < beneficiaries.length - 1 ? '1px solid var(--border)' : 'none',
                    background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent)', display: 'grid', placeItems: 'center', fontSize: '1rem', fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                    {b.first_name[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: 'var(--text)' }}>{b.first_name} {b.last_name}</div>
                    <div style={{ fontSize: '.8rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.email}</div>
                  </div>
                  <span style={{ color: 'var(--muted)', fontSize: '1.2rem' }}>›</span>
                </button>
              ))}
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/beneficiaries')}>
              + Manage Beneficiaries
            </button>
          </>
        )
      )}

      {/* ── Step 2: Amount ── */}
      {step === 'amount' && recipient && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '.8rem', marginBottom: '1.4rem', padding: '.8rem', background: 'rgba(0,212,170,.06)', borderRadius: 8, border: '1px solid rgba(0,212,170,.2)' }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent)', display: 'grid', placeItems: 'center', fontSize: '1rem', fontWeight: 700, color: '#fff' }}>
              {recipient.first_name[0]}
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>{recipient.first_name} {recipient.last_name}</div>
              <div style={{ fontSize: '.82rem', color: 'var(--muted)' }}>{recipient.email}</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '.8rem', marginBottom: '1rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Currency</label>
              <select value={currency} onChange={e => setCurrency(e.target.value)}>
                {CURRENCIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Amount</label>
              <input type="number" step=".01" min=".01" required value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" autoFocus />
            </div>
          </div>

          <div className="form-group">
            <label>Note (optional)</label>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Dinner, rent, etc." />
          </div>

          {/* Balance + insufficient funds warning */}
          {available !== null && (
            <div style={{ marginBottom: '.8rem', padding: '.6rem 1rem', background: 'var(--surface2)', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '.78rem', color: 'var(--muted)', fontWeight: 600 }}>Your {currency} balance</span>
              <span style={{ fontWeight: 700, fontSize: '.88rem', color: isInsufficient ? 'var(--danger)' : 'var(--accent2)' }}>
                {parseFloat(available).toLocaleString('en-CA', { minimumFractionDigits: 2 })} {currency}
              </span>
            </div>
          )}
          {isInsufficient && (
            <div style={{ padding: '.8rem 1rem', background: 'rgba(244,63,94,0.1)', border: '1px solid rgba(244,63,94,0.25)', borderRadius: 10, marginBottom: '.8rem' }}>
              <div style={{ fontSize: '.8rem', color: 'var(--danger)', fontWeight: 600, marginBottom: '.5rem' }}>
                ⚠️ Amount exceeds your {currency} balance
              </div>
              <button className="btn btn-sm btn-primary" onClick={() => navigate(`/wallet/${currency}?tab=deposit`)}>
                + Fund {currency} wallet →
              </button>
            </div>
          )}

          <div style={{ display: 'flex', gap: '.7rem', marginTop: '.5rem' }}>
            <button className="btn btn-ghost" onClick={() => setStep('pick')}>← Back</button>
            <button className="btn btn-primary" style={{ flex: 1 }} disabled={!amount || isInsufficient} onClick={() => setStep('confirm')}>
              Review →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Confirm ── */}
      {step === 'confirm' && recipient && (
        <>
          <div className="card">
            <h3 style={{ marginBottom: '1.2rem', fontSize: '1rem' }}>Confirm Transfer</h3>
            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '1rem', marginBottom: '1.2rem' }}>
              <InfoRow label="To"     value={`${recipient.first_name} ${recipient.last_name}`} />
              <InfoRow label="Email"  value={recipient.email} />
              <InfoRow label="Amount" value={`${currency} ${amount}`} />
              {note && <InfoRow label="Note" value={note} />}
            </div>
            <div style={{ display: 'flex', gap: '.7rem' }}>
              <button className="btn btn-ghost" onClick={() => setStep('amount')}>← Back</button>
              <button className="btn btn-success" style={{ flex: 1 }} onClick={() => { setPinError(''); setShowPin(true); }}>
                Enter PIN & Send →
              </button>
            </div>
          </div>

          {showPin && (
            <PinModal
              onConfirm={handleSend}
              onCancel={() => { setShowPin(false); setPinError(''); }}
              loading={loading}
              error={pinError}
            />
          )}
        </>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '.4rem 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--muted)', fontSize: '.85rem' }}>{label}</span>
      <span style={{ fontSize: '.85rem', fontFamily: mono ? 'monospace' : undefined }}>{value}</span>
    </div>
  );
}
