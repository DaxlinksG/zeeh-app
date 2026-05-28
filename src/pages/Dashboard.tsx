import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import api, { API_BASE } from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { toast } from '../components/Toast';

/** Inline banner + OTP modal for users who skipped email verification */
function EmailVerifyBanner() {
  const [showModal,   setShowModal]   = useState(false);
  const [otp,         setOtp]         = useState('');
  const [loading,     setLoading]     = useState(false);
  const [resending,   setResending]   = useState(false);
  const accessToken = useAuthStore(s => s.accessToken);
  const updateUser  = useAuthStore(s => s.updateUser);

  // A code was already sent when the account was created — open the modal directly.
  // Resend is only triggered explicitly by the user inside the modal.
  function openModal() { setOtp(''); setShowModal(true); }

  async function handleResend() {
    if (!accessToken || resending) return;
    setResending(true);
    try {
      await axios.post(`${API_BASE}/auth/resend-otp`, {}, { headers: { Authorization: `Bearer ${accessToken}` } });
      toast('A new code has been sent — check your email.');
    } catch (err: unknown) {
      // Show the API's message verbatim (e.g. "Please wait 52 seconds…") rather than a generic error
      const msg = (axios.isAxiosError(err) && err.response?.data?.message) || 'Could not resend code. Try again.';
      toast(msg, 'err');
    } finally { setResending(false); }
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
            A verification code was sent to your email when you registered. Enter it to unlock transactions.
          </div>
        </div>
        <button className="btn btn-primary" style={{ whiteSpace: 'nowrap', fontSize: '.84rem' }} onClick={openModal}>
          Enter code
        </button>
      </div>

      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}>
          <div className="card" style={{ width: '100%', maxWidth: 380 }}>
            <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '.4rem' }}>📧</div>
              <div style={{ fontWeight: 700, marginBottom: '.3rem' }}>Verify your email</div>
              <div style={{ fontSize: '.85rem', color: 'var(--muted)' }}>Enter the 6-digit code sent to your email when you signed up.</div>
            </div>
            <form onSubmit={handleVerify}>
              <input
                type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                placeholder="000000" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                style={{ width: '100%', textAlign: 'center', fontSize: '1.6rem', letterSpacing: '0.3em', fontFamily: 'monospace', marginBottom: '1rem', padding: '.7rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)' }}
                required
              />
              <div style={{ display: 'flex', gap: '.6rem', marginBottom: '1rem' }}>
                <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2 }} disabled={loading || otp.length !== 6}>
                  {loading ? <span className="spinner" /> : 'Verify'}
                </button>
              </div>
            </form>
            <div style={{ textAlign: 'center', fontSize: '.82rem', color: 'var(--muted)' }}>
              Didn't receive a code?{' '}
              <button
                type="button"
                onClick={handleResend}
                disabled={resending}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 'inherit', textDecoration: 'underline' }}
              >
                {resending ? 'Sending…' : 'Resend code'}
              </button>
            </div>
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
  const { user, updateUser } = useAuthStore();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading,  setLoading]  = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    // Fetch balances and sync profile in parallel.
    // The profile sync keeps kyc_status and email_verified fresh so admin
    // approvals are reflected immediately without a logout/login.
    Promise.all([
      api.get('/me/balance'),
      api.get('/me/profile'),
    ]).then(([balRes, profileRes]) => {
      setBalances(balRes.data.data?.balances ?? []);
      const u = profileRes.data.data;
      updateUser({ kyc_status: u.kyc_status, email_verified: u.email_verified });
    }).catch(() => {
      // Fallback: at least try to load balances independently
      api.get('/me/balance')
        .then(r => setBalances(r.data.data?.balances ?? []))
        .catch(() => toast('Failed to load balances', 'err'));
    }).finally(() => setLoading(false));
  }, [updateUser]);

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
