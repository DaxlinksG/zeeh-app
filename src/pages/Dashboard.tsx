import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import api, { API_BASE } from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { toast } from '../components/Toast';
import { PullToRefresh } from '../components/PullToRefresh';


interface Balance { currency: string; balance: string; available: string; }

const CURRENCY_FLAGS: Record<string, string> = {
  CAD: '🇨🇦', USD: '🇺🇸', NGN: '🇳🇬', GBP: '🇬🇧', EUR: '🇪🇺',
};

const CURRENCY_NAMES: Record<string, string> = {
  CAD: 'Canadian Dollar', USD: 'US Dollar', NGN: 'Nigerian Naira', GBP: 'British Pound', EUR: 'Euro',
};

// Revenue-first layout: Exchange + Pay get the large tiles
const primaryActions = [
  { label: 'Exchange', desc: 'Convert currencies',  icon: '⇄', path: '/exchange', grad: 'linear-gradient(135deg,#f59e0b,#f97316)' },
  { label: 'Pay',      desc: 'Bank transfer',        icon: '🏦', path: '/pay',      grad: 'linear-gradient(135deg,#0ea5e9,#38bdf8)' },
];
const secondaryActions = [
  { label: 'Send',    icon: '↗', path: '/send',    grad: 'linear-gradient(135deg,#7c3aed,#a78bfa)' },
  { label: 'Deposit', icon: '↙', path: '/deposit', grad: 'linear-gradient(135deg,#10b981,#34d399)' },
];

export default function Dashboard() {
  const { user, updateUser, accessToken } = useAuthStore();
  const [balances,      setBalances]      = useState<Balance[]>([]);
  const [loading,       setLoading]       = useState(true);
  // Don't render KYC action card until we have a confirmed-fresh status from the server.
  // Prevents the stale localStorage value ('none') showing the wrong card before the fetch.
  const [kycReady,      setKycReady]      = useState(false);
  // Email verify modal (inline — no separate component needed)
  const [showOtpModal,  setShowOtpModal]  = useState(false);
  const [otp,           setOtp]           = useState('');
  const [otpLoading,    setOtpLoading]    = useState(false);
  const [otpResending,  setOtpResending]  = useState(false);
  const navigate = useNavigate();

  const loadData = useCallback(async () => {
    // Use allSettled so a balance failure can't prevent the profile (kyc_status) from
    // updating, and vice versa — they are independent.
    const [balResult, profileResult] = await Promise.allSettled([
      api.get('/me/balance'),
      api.get('/me/profile'),
    ]);

    if (balResult.status === 'fulfilled') {
      setBalances(balResult.value.data.data?.balances ?? []);
    } else {
      toast('Could not load balances', 'err');
    }

    if (profileResult.status === 'fulfilled') {
      const u = profileResult.value.data.data;
      updateUser({ kyc_status: u.kyc_status, email_verified: u.email_verified, has_pin: u.has_pin });
    }

    // Mark kyc status as confirmed from server regardless of outcome —
    // if profile failed we fall back to the store value, which is acceptable.
    setKycReady(true);
    setLoading(false);
  }, [updateUser]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleVerifyEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken) return;
    setOtpLoading(true);
    try {
      await axios.post(`${API_BASE}/auth/verify-email`,
        { otp: otp.replace(/\s/g, '') },
        { headers: { Authorization: `Bearer ${accessToken}` } });
      updateUser({ email_verified: true });
      toast('Email verified! ✅');
      setShowOtpModal(false);
    } catch (err: unknown) {
      toast((axios.isAxiosError(err) && err.response?.data?.message) || 'Incorrect code', 'err');
    } finally { setOtpLoading(false); }
  }

  async function handleResendOtp() {
    if (!accessToken || otpResending) return;
    setOtpResending(true);
    try {
      await axios.post(`${API_BASE}/auth/resend-otp`, {}, { headers: { Authorization: `Bearer ${accessToken}` } });
      toast('New code sent — check your email.');
    } catch (err: unknown) {
      toast((axios.isAxiosError(err) && err.response?.data?.message) || 'Could not resend. Try again.', 'err');
    } finally { setOtpResending(false); }
  }

  // Build action items list — shown at top of dashboard.
  // KYC items only rendered after kycReady (server has confirmed the live status).
  type ActionItem = { key: string; icon: string; title: string; desc: string; cta?: string; onPress?: () => void };
  const actionItems: ActionItem[] = [
    ...(user?.email_verified === false ? [{
      key: 'email', icon: '📧', title: 'Verify your email',
      desc: 'Required before making any transaction',
      cta: 'Verify', onPress: () => { setOtp(''); setShowOtpModal(true); },
    }] : []),
    ...(kycReady && user?.kyc_status === 'none' ? [{
      key: 'kyc', icon: '🪪', title: 'Complete KYC',
      desc: 'Unlock bank transfers & currency exchange',
      cta: 'Start', onPress: () => navigate('/profile'),
    }] : []),
    ...(kycReady && user?.kyc_status === 'pending' ? [{
      key: 'kyc-pending', icon: '⏳', title: 'KYC under review',
      desc: 'Usually 24 hours. Bank transfers enabled once approved.',
    }] : []),
    ...(!user?.has_pin ? [{
      key: 'pin', icon: '🔐', title: 'Set transaction PIN',
      desc: 'Required before sending or exchanging money',
      cta: 'Set PIN', onPress: () => navigate('/profile'),
    }] : []),
  ];

  return (
    <>
    <PullToRefresh onRefresh={loadData} />
    <div style={{ maxWidth: 800 }}>
      {/* Greeting */}
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', color: 'var(--muted)', marginBottom: '.4rem' }}>
          Good {getGreeting()}
        </div>
        <h1 style={{
          fontSize: '2rem', fontWeight: 700, letterSpacing: '-.02em',
          background: 'var(--g-heading)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
        }}>
          {user?.first_name} 👋
        </h1>
      </div>

      {/* Unified action items */}
      {actionItems.length > 0 && (
        <div className="card" style={{ marginBottom: '1.5rem', padding: '1rem 1.2rem', borderColor: 'rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.05)' }}>
          <div style={{ fontSize: '.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', color: 'var(--warn)', marginBottom: '.8rem' }}>
            {actionItems.length} action{actionItems.length > 1 ? 's' : ''} needed
          </div>
          {actionItems.map((item, i) => (
            <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: '.8rem', padding: '.55rem 0', borderBottom: i < actionItems.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <span style={{ fontSize: '1.2rem', width: 28, textAlign: 'center', flexShrink: 0 }}>{item.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '.88rem' }}>{item.title}</div>
                <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginTop: '.1rem' }}>{item.desc}</div>
              </div>
              {item.cta && item.onPress && (
                <button className="btn btn-sm btn-primary" style={{ flexShrink: 0 }} onClick={item.onPress}>
                  {item.cta}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Email OTP modal */}
      {showOtpModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}>
          <div className="card" style={{ width: '100%', maxWidth: 360 }}>
            <div style={{ textAlign: 'center', marginBottom: '1.4rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '.4rem' }}>📧</div>
              <div style={{ fontWeight: 700, marginBottom: '.3rem' }}>Verify your email</div>
              <div style={{ fontSize: '.84rem', color: 'var(--muted)' }}>Enter the 6-digit code sent when you registered</div>
            </div>
            <form onSubmit={handleVerifyEmail}>
              <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                placeholder="000000" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                style={{ textAlign: 'center', fontSize: '1.6rem', letterSpacing: '0.3em', fontFamily: 'monospace', marginBottom: '1rem' }}
                required />
              <div style={{ display: 'flex', gap: '.6rem', marginBottom: '1rem' }}>
                <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setShowOtpModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2 }} disabled={otpLoading || otp.length !== 6}>
                  {otpLoading ? <span className="spinner" /> : 'Verify'}
                </button>
              </div>
            </form>
            <div style={{ textAlign: 'center', fontSize: '.82rem', color: 'var(--muted)' }}>
              Didn't get it?{' '}
              <button type="button" onClick={handleResendOtp} disabled={otpResending}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 'inherit', textDecoration: 'underline' }}>
                {otpResending ? 'Sending…' : 'Resend code'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Primary actions — Exchange + Pay (revenue drivers, larger tiles) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem', marginBottom: '.8rem' }}>
        {primaryActions.map(a => (
          <button
            key={a.label}
            onClick={() => navigate(a.path)}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 20,
              padding: '1.4rem 1rem',
              cursor: 'pointer',
              display: 'flex', flexDirection: 'column',
              alignItems: 'flex-start', gap: '.7rem',
              transition: 'all .18s cubic-bezier(.4,0,.2,1)',
              textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.transform = ''; }}
          >
            <div style={{ width: 52, height: 52, borderRadius: 16, background: a.grad, display: 'grid', placeItems: 'center', fontSize: '1.4rem', boxShadow: '0 4px 16px rgba(0,0,0,0.3)' }}>
              {a.icon}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '.95rem', color: 'var(--text)' }}>{a.label}</div>
              <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginTop: '.1rem' }}>{a.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Secondary actions — Send + Deposit (smaller tiles) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem', marginBottom: '2rem' }}>
        {secondaryActions.map(a => (
          <button
            key={a.label}
            onClick={() => navigate(a.path)}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 16,
              padding: '1rem .8rem',
              cursor: 'pointer',
              display: 'flex', flexDirection: 'row',
              alignItems: 'center', gap: '.7rem',
              transition: 'all .18s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; }}
          >
            <div style={{ width: 40, height: 40, borderRadius: 12, background: a.grad, display: 'grid', placeItems: 'center', fontSize: '1.1rem', flexShrink: 0 }}>
              {a.icon}
            </div>
            <span style={{ fontWeight: 600, fontSize: '.88rem', color: 'var(--text)' }}>{a.label}</span>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px,1fr))', gap: '.8rem' }}>
          {balances.map(b => (
            <div
              key={b.currency}
              className="card"
              style={{ cursor: 'pointer', transition: 'all .18s ease' }}
              onClick={() => navigate(`/wallet/${b.currency}`)}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(139,92,246,0.3)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = ''; (e.currentTarget as HTMLElement).style.borderColor = ''; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '.7rem', marginBottom: '1rem' }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 12,
                  background: 'var(--surface2)',
                  display: 'grid', placeItems: 'center',
                  fontSize: '1.3rem', flexShrink: 0,
                }}>
                  {CURRENCY_FLAGS[b.currency] ?? '🌐'}
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '.92rem' }}>{b.currency}</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--muted)' }}>{CURRENCY_NAMES[b.currency] ?? b.currency}</div>
                </div>
              </div>
              <div style={{ fontSize: '1.65rem', fontWeight: 700, letterSpacing: '-.02em', marginBottom: '.1rem' }}>
                {fmt(b.available)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: '.72rem', color: 'var(--muted)' }}>Available balance</div>
                <div style={{ fontSize: '.7rem', color: 'var(--accent)', fontWeight: 600 }}>View →</div>
              </div>
              {parseFloat(b.balance) !== parseFloat(b.available) && (
                <div style={{
                  marginTop: '.6rem', padding: '.35rem .7rem',
                  background: 'rgba(245,158,11,.1)',
                  borderRadius: 8, fontSize: '.72rem',
                  color: 'var(--warn)',
                }}>
                  {fmt(b.balance)} total · some reserved
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
    </>
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
