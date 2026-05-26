import { useEffect, useState } from 'react';
import api from '../lib/api';
import { toast } from '../components/Toast';

interface Txn {
  txn_id: string; type: string; direction: 'credit' | 'debit';
  currency: string; amount: string; balance_after: string;
  reference: string; description: string; created_at: string;
}

const TYPE_LABELS: Record<string, string> = {
  deposit:     'Deposit',
  transfer:    'Transfer',
  swap_debit:  'Exchange (sent)',
  swap_credit: 'Exchange (received)',
  refund:      'Refund',
  fee:         'Fee',
};

export default function Transactions() {
  const [txns,    setTxns]    = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter,  setFilter]  = useState('all');

  useEffect(() => {
    api.get('/me/transactions?limit=100')
      .then(r => setTxns(r.data.data?.transactions ?? []))
      .catch(() => toast('Failed to load transactions', 'err'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = filter === 'all' ? txns : txns.filter(t =>
    filter === 'credit' ? t.direction === 'credit' : t.direction === 'debit'
  );

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.6rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Transactions</h1>
        <div style={{ display: 'flex', gap: '.3rem' }}>
          {['all', 'credit', 'debit'].map(f => (
            <button key={f} className="btn btn-sm" style={{
              background: filter === f ? 'var(--accent)' : 'var(--surface)',
              color: filter === f ? '#fff' : 'var(--muted)',
              border: `1px solid ${filter === f ? 'var(--accent)' : 'var(--border)'}`,
            }} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'credit' ? 'In' : 'Out'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem' }}><span className="spinner spinner-lg" /></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontSize: '3rem', marginBottom: '.8rem' }}>📋</div>
          <div>No transactions yet</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {filtered.map((t, i) => (
            <div key={t.txn_id} style={{
              display: 'flex', alignItems: 'center', padding: '1rem 1.2rem',
              borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
              gap: '1rem',
            }}>
              {/* Icon */}
              <div style={{
                width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
                display: 'grid', placeItems: 'center', fontSize: '1rem',
                background: t.direction === 'credit' ? 'rgba(0,212,170,.12)' : 'rgba(255,77,109,.12)',
              }}>
                {t.direction === 'credit' ? '↙' : '↗'}
              </div>

              {/* Details */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: '.9rem' }}>{TYPE_LABELS[t.type] ?? t.type}</div>
                <div style={{ fontSize: '.77rem', color: 'var(--muted)', marginTop: '.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.description}
                </div>
                <div style={{ fontSize: '.73rem', color: 'var(--muted)', marginTop: '.1rem' }}>
                  {fmtDate(t.created_at)}
                </div>
              </div>

              {/* Amount */}
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontWeight: 600, color: t.direction === 'credit' ? 'var(--accent2)' : 'var(--danger)' }}>
                  {t.direction === 'credit' ? '+' : '−'} {t.currency} {t.amount}
                </div>
                <div style={{ fontSize: '.73rem', color: 'var(--muted)', marginTop: '.1rem' }}>
                  Bal: {t.currency} {t.balance_after}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
