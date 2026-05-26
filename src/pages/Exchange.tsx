import { useState, useEffect } from 'react';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { toast } from '../components/Toast';

const CURRENCIES = ['CAD', 'USD', 'NGN', 'GBP', 'EUR'];

export default function Exchange() {
  const { user } = useAuthStore();
  const [from,    setFrom]    = useState('CAD');
  const [to,      setTo]      = useState('NGN');
  const [amount,  setAmount]  = useState('');
  const [rate,    setRate]    = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [rateLoading, setRateLoading] = useState(false);
  const [done,    setDone]    = useState<{ from_amount: number; to_amount: number; rate: number } | null>(null);

  const needsKyc = user?.kyc_status !== 'approved';

  // Fetch rate when from/to changes
  useEffect(() => {
    if (from === to) { setRate(null); return; }
    setRateLoading(true);
    api.get(`/me/rates?from=${from}&to=${to}`)
      .then(r => setRate(parseFloat(r.data.data?.rate)))
      .catch(() => setRate(null))
      .finally(() => setRateLoading(false));
  }, [from, to]);

  const toAmount = rate && amount ? (parseFloat(amount) * rate).toFixed(2) : '';

  async function handleSwap() {
    setLoading(true);
    try {
      const { data } = await api.post('/me/swap', {
        amount, from_currency: from, to_currency: to,
      });
      const s = data.data?.settlement;
      setDone({ from_amount: s?.from_amount, to_amount: s?.to_amount, rate: s?.rate });
      toast(`Exchanged ${from} ${amount} → ${to} ${toAmount}!`);
    } catch (err: unknown) {
      const d = (err as { response?: { data?: { message?: string; data?: { available?: string } } } }).response?.data;
      const avail = d?.data?.available;
      toast(avail ? `Insufficient balance. Available: ${from} ${avail}` : (d?.message ?? 'Exchange failed'), 'err');
    } finally { setLoading(false); }
  }

  if (done) return (
    <div style={{ maxWidth: 480, margin: '4rem auto', textAlign: 'center' }}>
      <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>✅</div>
      <h2 style={{ marginBottom: '.5rem' }}>Exchange Complete!</h2>
      <div className="card" style={{ textAlign: 'left', marginTop: '1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ textAlign: 'center', padding: '1rem 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--danger)' }}>− {from} {done.from_amount?.toFixed(2)}</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--accent2)', marginTop: '.4rem' }}>+ {to} {done.to_amount?.toFixed(2)}</div>
        </div>
        <div style={{ padding: '.8rem 0', fontSize: '.85rem', color: 'var(--muted)', textAlign: 'center' }}>
          Rate: 1 {from} = {done.rate?.toFixed(4)} {to}
        </div>
      </div>
      <button className="btn btn-primary" onClick={() => { setDone(null); setAmount(''); }}>New Exchange</button>
    </div>
  );

  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '1.6rem' }}>Exchange Currency</h1>

      {needsKyc && (
        <div style={{ background: 'rgba(255,77,109,.08)', border: '1px solid rgba(255,77,109,.25)', borderRadius: 'var(--radius)', padding: '1rem', marginBottom: '1.2rem', fontSize: '.85rem', color: 'var(--danger)' }}>
          🔒 KYC verification required to use currency exchange.
        </div>
      )}

      <div className="card">
        {/* From */}
        <div className="form-group">
          <label>You Send</label>
          <div style={{ display: 'flex', gap: '.6rem' }}>
            <select value={from} onChange={e => setFrom(e.target.value)} style={{ width: 100, flexShrink: 0 }}>
              {CURRENCIES.filter(c => c !== to).map(c => <option key={c}>{c}</option>)}
            </select>
            <input type="number" step=".01" min=".01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
          </div>
        </div>

        {/* Swap icon */}
        <div style={{ textAlign: 'center', margin: '.5rem 0' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { const tmp = from; setFrom(to); setTo(tmp); }}
            style={{ borderRadius: '50%', padding: '.5rem' }}
          >⇅</button>
        </div>

        {/* To */}
        <div className="form-group">
          <label>You Receive</label>
          <div style={{ display: 'flex', gap: '.6rem' }}>
            <select value={to} onChange={e => setTo(e.target.value)} style={{ width: 100, flexShrink: 0 }}>
              {CURRENCIES.filter(c => c !== from).map(c => <option key={c}>{c}</option>)}
            </select>
            <input
              readOnly
              value={toAmount}
              placeholder={rateLoading ? 'Loading rate…' : from === to ? 'Select different currencies' : '0.00'}
              style={{ background: 'var(--surface2)', cursor: 'not-allowed' }}
            />
          </div>
        </div>

        {/* Rate */}
        {rate !== null && from !== to && (
          <div style={{ textAlign: 'center', fontSize: '.82rem', color: 'var(--muted)', margin: '.5rem 0 1rem', padding: '.5rem', background: 'var(--bg)', borderRadius: 6 }}>
            1 {from} = <strong style={{ color: 'var(--text)' }}>{rate.toFixed(4)}</strong> {to}
          </div>
        )}

        <button
          className="btn btn-success btn-full"
          disabled={!amount || !rate || from === to || needsKyc || loading}
          onClick={handleSwap}
        >
          {loading ? <span className="spinner" /> : `Exchange ${from} → ${to}`}
        </button>
      </div>
    </div>
  );
}
