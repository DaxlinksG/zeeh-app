import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { toast } from '../components/Toast';

interface Balance { currency: string; balance: string; available: string; }

const CURRENCY_FLAGS: Record<string, string> = {
  CAD: '🇨🇦', USD: '🇺🇸', NGN: '🇳🇬', GBP: '🇬🇧', EUR: '🇪🇺',
};

const CURRENCY_NAMES: Record<string, string> = {
  CAD: 'Canadian Dollar', USD: 'US Dollar', NGN: 'Nigerian Naira', GBP: 'British Pound', EUR: 'Euro',
};

const quickActions = [
  { label: 'Send',     icon: '↗', path: '/send',         color: 'var(--accent)' },
  { label: 'Pay',      icon: '🏦', path: '/pay',          color: 'var(--accent2)' },
  { label: 'Exchange', icon: '⇄', path: '/exchange',     color: '#ff8c42' },
  { label: 'Deposit',  icon: '↙', path: '/deposit',      color: '#00b4d8' },
];

export default function Dashboard() {
  const { user } = useAuthStore();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading,  setLoading]  = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/me/balance')
      .then(r => setBalances(r.data.data?.balances ?? []))
      .catch(() => toast('Failed to load balances', 'err'))
      .finally(() => setLoading(false));
  }, []);

  // totalUsd reserved for future portfolio value widget

  return (
    <div style={{ maxWidth: 800 }}>
      {/* Greeting */}
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '1.6rem', fontWeight: 700 }}>
          Good {getGreeting()}, {user?.first_name} 👋
        </h1>
        <p style={{ color: 'var(--muted)', marginTop: '.3rem' }}>Here's your account overview</p>
      </div>

      {/* KYC banner */}
      {user?.kyc_status !== 'approved' && (
        <div style={{
          background: 'rgba(255,165,0,.08)', border: '1px solid rgba(255,165,0,.3)',
          borderRadius: 'var(--radius)', padding: '1rem 1.2rem',
          marginBottom: '1.5rem', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: '1rem',
        }}>
          <div>
            <strong style={{ color: 'var(--warn)' }}>
              {user?.kyc_status === 'pending' ? '⏳ KYC under review' : '⚠️ Complete your KYC'}
            </strong>
            <div style={{ fontSize: '.84rem', color: 'var(--muted)', marginTop: '.2rem' }}>
              {user?.kyc_status === 'pending'
                ? 'Your identity verification is being reviewed. Bank transfers will be enabled once approved.'
                : 'Verify your identity to unlock bank transfers and currency exchange.'}
            </div>
          </div>
          {user?.kyc_status === 'none' && (
            <button className="btn btn-sm" style={{ background: 'var(--warn)', color: '#000', whiteSpace: 'nowrap' }} onClick={() => navigate('/profile')}>
              Verify Now
            </button>
          )}
        </div>
      )}

      {/* Quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '.8rem', marginBottom: '2rem' }}>
        {quickActions.map(a => (
          <button
            key={a.label}
            onClick={() => navigate(a.path)}
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '1.1rem .8rem',
              cursor: 'pointer', display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: '.5rem', transition: 'border-color .15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = a.color)}
            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            <span style={{ fontSize: '1.4rem', color: a.color }}>{a.icon}</span>
            <span style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--text)' }}>{a.label}</span>
          </button>
        ))}
      </div>

      {/* Balances */}
      <div className="section-header">
        <span className="section-title">Your Balances</span>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/deposit')}>+ Add Money</button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem' }}><span className="spinner spinner-lg" /></div>
      ) : balances.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '.8rem' }}>💳</div>
          <div style={{ marginBottom: '.5rem' }}>No balances yet</div>
          <button className="btn btn-success btn-sm" onClick={() => navigate('/deposit')}>Make your first deposit</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))', gap: '.8rem' }}>
          {balances.map(b => (
            <div key={b.currency} className="card" style={{ cursor: 'pointer' }} onClick={() => navigate('/transactions')}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '.8rem' }}>
                <span style={{ fontSize: '1.3rem' }}>{CURRENCY_FLAGS[b.currency] ?? '🌐'}</span>
                <span className="badge badge-grey">{b.currency}</span>
              </div>
              <div style={{ fontSize: '1.6rem', fontWeight: 700, marginBottom: '.15rem' }}>
                {fmt(b.available)} <span style={{ fontSize: '1rem', color: 'var(--muted)' }}>{b.currency}</span>
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--muted)' }}>
                {CURRENCY_NAMES[b.currency] ?? b.currency}
              </div>
              {parseFloat(b.balance) !== parseFloat(b.available) && (
                <div style={{ fontSize: '.75rem', color: 'var(--warn)', marginTop: '.4rem' }}>
                  {fmt(b.balance)} total (some reserved)
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmt(n: string) {
  return parseFloat(n || '0').toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}
