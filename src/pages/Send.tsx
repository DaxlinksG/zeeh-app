import { useState } from 'react';
import api from '../lib/api';
import { toast } from '../components/Toast';

interface Recipient { user_id: string; first_name: string; last_name: string; email: string; }

const CURRENCIES = ['CAD', 'USD', 'NGN', 'GBP', 'EUR'];

export default function Send() {
  const [step, setStep] = useState<'search' | 'amount' | 'confirm' | 'done'>(  'search');
  const [email,     setEmail]     = useState('');
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [currency,  setCurrency]  = useState('CAD');
  const [amount,    setAmount]    = useState('');
  const [note,      setNote]      = useState('');
  const [ref,       setRef]       = useState('');
  const [loading,   setLoading]   = useState(false);

  async function searchUser(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.get(`/me/users/search?email=${encodeURIComponent(email)}`);
      setRecipient(data.data);
      setStep('amount');
    } catch {
      toast('User not found', 'err');
    } finally { setLoading(false); }
  }

  async function handleSend() {
    setLoading(true);
    try {
      const { data } = await api.post('/me/send', {
        recipient_email: recipient!.email, currency, amount, note: note || undefined,
      });
      setRef(data.data.reference);
      setStep('done');
      toast(`Sent ${currency} ${amount} to ${recipient!.first_name}!`);
    } catch (err: unknown) {
      const d = (err as { response?: { data?: { message?: string; data?: { available?: string } } } }).response?.data;
      const available = d?.data?.available;
      toast(available ? `Insufficient balance. Available: ${currency} ${available}` : (d?.message ?? 'Send failed'), 'err');
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
        <InfoRow label="Amount" value={`${currency} ${amount}`} />
        <InfoRow label="To" value={`${recipient?.first_name} ${recipient?.last_name} (${recipient?.email})`} />
        {note && <InfoRow label="Note" value={note} />}
      </div>
      <button className="btn btn-primary" onClick={() => { setStep('search'); setRecipient(null); setEmail(''); setAmount(''); setNote(''); }}>
        Send Again
      </button>
    </div>
  );

  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '1.6rem' }}>Send Money</h1>

      {step === 'search' && (
        <div className="card">
          <form onSubmit={searchUser}>
            <div className="form-group">
              <label>Recipient's Email</label>
              <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="friend@email.com" autoFocus />
            </div>
            <button className="btn btn-primary btn-full" disabled={loading}>
              {loading ? <span className="spinner" /> : 'Find Recipient →'}
            </button>
          </form>
        </div>
      )}

      {step === 'amount' && recipient && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '.8rem', marginBottom: '1.4rem', padding: '.8rem', background: 'rgba(0,212,170,.06)', borderRadius: 8, border: '1px solid rgba(0,212,170,.2)' }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent)', display: 'grid', placeItems: 'center', fontSize: '1.1rem', fontWeight: 700 }}>
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

          <div style={{ display: 'flex', gap: '.7rem', marginTop: '.5rem' }}>
            <button className="btn btn-ghost" onClick={() => setStep('search')}>← Back</button>
            <button className="btn btn-primary" style={{ flex: 1 }} disabled={!amount || loading} onClick={() => setStep('confirm')}>
              Review →
            </button>
          </div>
        </div>
      )}

      {step === 'confirm' && recipient && (
        <div className="card">
          <h3 style={{ marginBottom: '1.2rem', fontSize: '1rem' }}>Confirm Transfer</h3>
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '1rem', marginBottom: '1.2rem' }}>
            <InfoRow label="To"       value={`${recipient.first_name} ${recipient.last_name}`} />
            <InfoRow label="Email"    value={recipient.email} />
            <InfoRow label="Amount"   value={`${currency} ${amount}`} />
            {note && <InfoRow label="Note" value={note} />}
          </div>
          <div style={{ display: 'flex', gap: '.7rem' }}>
            <button className="btn btn-ghost" onClick={() => setStep('amount')}>← Back</button>
            <button className="btn btn-success" style={{ flex: 1 }} disabled={loading} onClick={handleSend}>
              {loading ? <span className="spinner" /> : `Send ${currency} ${amount}`}
            </button>
          </div>
        </div>
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
