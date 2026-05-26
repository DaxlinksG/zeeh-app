import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import api, { API_BASE } from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { toast } from '../components/Toast';

/** Inline banner + OTP modal for users who skipped email verification */
function EmailVerifyBanner() {
  const [showModal, setShowModal] = useState(false);
  const [otp,       setOtp]       = useState('');
  const [loading,   setLoading]   = useState(false);
  const { accessToken, updateUser } = useAuthStore(s => ({ accessToken: s.accessToken, updateUser: s.updateUser }));

  async function sendResend() {
    if (!accessToken) return;
    try {
      await axios.post(`${API_BASE}/auth/resend-otp`, {}, { headers: { Authorization: `Bearer ${accessToken}` } });
      toast('Verification code sent — check your email.');
      setShowModal(true);
    } catch { toast('Could not send code. Try again.', 'err'); }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken) return;
    setLoading(true);
    try {
      await axios.post(
        `${API_BASE}/auth/verify-email`,
        { otp: otp.replace(/\s/g, '') },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      updateUser({ email_verified: true });
      toast('Email verified! ✅');
      setShowModal(false);
    } catch (err: unknown) {
      toast((axios.isAxiosError(err) && err.response?.data?.message) || 'Incorrect code', 'err');
    } finally { setLoading(false); }
  }

  return (
    <>
      <div style={{
        background: 'rgba(108,99,255,.1)', border: '1px solid rgba(108,99,255,.35)',
        borderRadius: 'var(--radius)', padding: '1rem 1.2rem',
        marginBottom: '1.5rem', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: '1rem',
      }}>
        <div>
          <strong style={{ color: 'var(--accent)' }}>📧 Verify your email</strong>
          <div style={{ fontSize: '.84rem', color: 'var(--muted)', marginTop: '.2rem' }}>
            Verify your email address to secure your account and receive transaction alerts.
          </div>
        </div>
        <button className="btn btn-primary" style={{ whiteSpace: 'nowrap', fontSize: '.84rem' }} onClick={sendResend}>
          Verify now
        </button>
      </div>

      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}>
          <div className="card" style={{ width: '100%', maxWidth: 380 }}>
            <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '.4rem' }}>📧</div>
              <div style={{ fontWeight: 700, marginBottom: '.3rem' }}>Enter your code</div>
              <div style={{ fontSize: '.85rem', color: 'var(--muted)' }}>Check your email for a 6-digit code.</div>
            </div>
            <form onSubmit={handleVerify}>
              <input
                type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                placeholder="000000" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                style={{ width: '100%', textAlign: 'center', fontSize: '1.6rem', letterSpacing: '0.3em', fontFamily: 'monospace', marginBottom: '1rem', padding: '.7rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)' }}
                required
              />
              <div style={{ display: 'flex', gap: '.6rem' }}>
                <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2 }} disabled={loading || otp.length !== 6}>
                  {loading ? <span className="spinner" /> : 'Verify'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

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

      {/* Email verification banner */}
      {user && user.email_verified === false && (
        <EmailVerifyBanner />
      )}

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
