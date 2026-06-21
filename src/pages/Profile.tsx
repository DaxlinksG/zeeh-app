import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { toast } from '../components/Toast';
import { type ThemePreference, getThemePreference, setTheme } from '../lib/theme';
import { KycWizard } from '../components/KycWizard';

/** Shown while KYC is under manual review. Polls every 15s and lets user check manually. */
function PendingKycPanel({ onStatusChange }: { onStatusChange: (s: string) => void }) {
  const [checking, setChecking] = useState(false);

  const checkStatus = useCallback(async (silent = false) => {
    if (!silent) setChecking(true);
    try {
      const { data } = await api.get('/me/profile');
      const status: string = data?.data?.kyc_status ?? 'pending';
      if (status !== 'pending') {
        onStatusChange(status);
        if (!silent) toast(status === 'approved' ? 'Identity verified! ✅' : 'KYC update received');
      } else if (!silent) {
        toast('Still under review — check back soon');
      }
    } catch { /* silent */ }
    finally { if (!silent) setChecking(false); }
  }, [onStatusChange]);

  // Auto-poll every 15s while this panel is mounted
  useEffect(() => {
    const id = setInterval(() => checkStatus(true), 15_000);
    return () => clearInterval(id);
  }, [checkStatus]);

  return (
    <div className="card" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
      <div style={{ fontSize: '3.5rem', marginBottom: '.8rem' }}>⏳</div>
      <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: '.4rem' }}>Under Review</div>
      <div style={{ color: 'var(--muted)', fontSize: '.88rem', marginBottom: '1.2rem' }}>
        Usually within a few hours. We'll notify you when done.
      </div>
      <button className="btn btn-sm" onClick={() => checkStatus(false)} disabled={checking}
        style={{ margin: '0 auto' }}>
        {checking ? <span className="spinner" /> : '↻ Check for update'}
      </button>
    </div>
  );
}

type KycStatus = 'none' | 'pending' | 'approved' | 'rejected';
type Tab = 'profile' | 'kyc' | 'security';

const KYC_STATUS_INFO: Record<KycStatus, { label: string; badge: string; desc: string }> = {
  none:     { label: 'Not Verified',  badge: 'badge-grey',  desc: 'Complete identity verification to unlock all features.' },
  pending:  { label: 'Under Review',  badge: 'badge-warn',  desc: 'Your KYC is being reviewed. This usually takes a few hours.' },
  approved: { label: 'Verified',      badge: 'badge-green', desc: 'Your identity has been verified. All features are unlocked.' },
  rejected: { label: 'Rejected',      badge: 'badge-red',   desc: 'Your KYC was not approved. Please re-submit with correct information.' },
};

const COUNTRIES = ['Canada','Nigeria','United States','United Kingdom','Germany','France','Ghana','Kenya','South Africa','Other'];

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'dark',   label: 'Dark',  icon: '🌙' },
  { value: 'system', label: 'Auto',  icon: '💻' },
  { value: 'light',  label: 'Light', icon: '☀️' },
];

export default function Profile() {
  const { user, updateUser, logout } = useAuthStore();
  const navigate   = useNavigate();
  const location   = useLocation();
  const [loading,        setLoading]        = useState(false);
  const [tab,            setTab]            = useState<Tab>('profile');
  const [themePref,      setThemePref]      = useState<ThemePreference>(getThemePreference);
  // True until the initial profile fetch resolves — prevents showing stale KYC state
  const [kycStatusReady, setKycStatusReady] = useState(false);
  // When redirected back from KYC widget with ?kyc_done=1, poll until webhook lands
  const [kycPolling,     setKycPolling]     = useState(false);
  const kycPollRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const kycPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Profile form — name is display-only; only phone + country are editable
  const [profile, setProfile] = useState({
    phone:   '',
    country: '',
  });

  // Security / PIN
  const [hasPin,    setHasPin]     = useState(false);
  const [pinLoading, setPinLoading] = useState(false);
  const [setForm,   setSetForm]    = useState({ pin: '', confirm: '' });
  const [chgForm,   setChgForm]    = useState({ current_pin: '', new_pin: '', new_confirm: '' });
  const [rstForm,   setRstForm]    = useState({ password: '', new_pin: '', new_confirm: '' });

  useEffect(() => {
    const kycDone = new URLSearchParams(location.search).get('kyc_done') === '1';

    api.get('/me/profile').then(r => {
      const u = r.data.data;
      setProfile({ phone: u.phone ?? '', country: u.country ?? '' });
      updateUser({ kyc_status: u.kyc_status, email_verified: u.email_verified, has_pin: u.has_pin });
      setHasPin(u.has_pin ?? false);

      // ?kyc_done=1: redirected back from the KYC widget. If the webhook hasn't
      // landed yet (status still 'none'), switch to KYC tab and keep polling
      // until the status changes so we don't show the wizard from scratch.
      if (kycDone) {
        setTab('kyc');
        if (u.kyc_status === 'none' || u.kyc_status === 'rejected') {
          setKycPolling(true);
        }
        // Strip ?kyc_done=1 so a reload/back-nav can't re-trigger polling
        // off a stale query param once this redirect has been handled.
        navigate('/profile', { replace: true });
      }
    }).catch(() => {})
      .finally(() => setKycStatusReady(true));
  }, [updateUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll every 4s while kycPolling — stops once status becomes pending/approved/rejected.
  // rejected is a terminal state too — must stop polling and show the
  // re-submit panel, not be left spinning as if still in progress.
  // Bails out after 60s if the webhook never lands, so a dropped/failed webhook
  // can't trap the user on this spinner forever — falls back to the wizard instead.
  useEffect(() => {
    if (!kycPolling) {
      if (kycPollRef.current) { clearInterval(kycPollRef.current); kycPollRef.current = null; }
      if (kycPollTimeoutRef.current) { clearTimeout(kycPollTimeoutRef.current); kycPollTimeoutRef.current = null; }
      return;
    }
    kycPollRef.current = setInterval(async () => {
      try {
        const { data } = await api.get('/me/profile');
        const status: string = data?.data?.kyc_status ?? 'none';
        if (status === 'pending' || status === 'approved' || status === 'rejected') {
          updateUser({ kyc_status: status });
          setKycPolling(false);
        }
      } catch { /* retry */ }
    }, 4000);
    kycPollTimeoutRef.current = setTimeout(() => {
      setKycPolling(false);
      toast('Still waiting on verification — you can try again.', 'err');
    }, 60000);
    return () => {
      if (kycPollRef.current) { clearInterval(kycPollRef.current); kycPollRef.current = null; }
      if (kycPollTimeoutRef.current) { clearTimeout(kycPollTimeoutRef.current); kycPollTimeoutRef.current = null; }
    };
  }, [kycPolling, updateUser]);


  function handleTheme(pref: ThemePreference) {
    setThemePref(pref);
    setTheme(pref);
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.put('/me/profile', profile);
      toast('Profile updated');
    } catch { toast('Update failed', 'err'); }
    finally { setLoading(false); }
  }

  async function handleSetPin(e: React.FormEvent) {
    e.preventDefault();
    if (setForm.pin !== setForm.confirm) { toast('PINs do not match', 'err'); return; }
    setPinLoading(true);
    try {
      await api.post('/me/pin/set', { pin: setForm.pin });
      setHasPin(true);
      setSetForm({ pin: '', confirm: '' });
      toast('Transaction PIN set 🔐');
    } catch (err: unknown) {
      toast((err as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Failed to set PIN', 'err');
    } finally { setPinLoading(false); }
  }

  async function handleChangePin(e: React.FormEvent) {
    e.preventDefault();
    if (chgForm.new_pin !== chgForm.new_confirm) { toast('New PINs do not match', 'err'); return; }
    setPinLoading(true);
    try {
      await api.post('/me/pin/change', { current_pin: chgForm.current_pin, new_pin: chgForm.new_pin });
      setChgForm({ current_pin: '', new_pin: '', new_confirm: '' });
      toast('Transaction PIN updated ✅');
    } catch (err: unknown) {
      toast((err as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Failed to change PIN', 'err');
    } finally { setPinLoading(false); }
  }

  async function handleResetPin(e: React.FormEvent) {
    e.preventDefault();
    if (rstForm.new_pin !== rstForm.new_confirm) { toast('New PINs do not match', 'err'); return; }
    setPinLoading(true);
    try {
      await api.post('/me/pin/reset', { password: rstForm.password, new_pin: rstForm.new_pin });
      setHasPin(true);
      setRstForm({ password: '', new_pin: '', new_confirm: '' });
      toast('Transaction PIN reset ✅');
    } catch (err: unknown) {
      toast((err as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Failed to reset PIN', 'err');
    } finally { setPinLoading(false); }
  }

  const kycStatus = (user?.kyc_status ?? 'none') as KycStatus;
  const kycInfo   = KYC_STATUS_INFO[kycStatus];

  return (
    <div style={{ maxWidth: 560 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '1.6rem' }}>Profile & Settings</h1>

      {/* Appearance */}
      <div className="card" style={{ marginBottom: '1.4rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: '.15rem' }}>Appearance</div>
          <div style={{ fontSize: '.82rem', color: 'var(--muted)' }}>Follows your device by default</div>
        </div>
        <div style={{ display: 'flex', gap: '.25rem', background: 'var(--bg)', borderRadius: 100, padding: '.3rem' }}>
          {THEME_OPTIONS.map(({ value, label, icon }) => (
            <button key={value} onClick={() => handleTheme(value)} style={{
              padding: '.38rem .85rem', borderRadius: 100, border: 'none',
              background: themePref === value ? 'var(--surface2)' : 'transparent',
              color: themePref === value ? 'var(--text)' : 'var(--muted)',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: '.8rem', fontWeight: 600,
              transition: 'all .15s', display: 'flex', alignItems: 'center', gap: '.3rem',
            }}>
              <span>{icon}</span>{label}
            </button>
          ))}
        </div>
      </div>

      {/* KYC status card */}
      <div className="card" style={{ marginBottom: '1.4rem', display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.4rem' }}>
            <span style={{ fontWeight: 600 }}>Identity Verification</span>
            <span className={`badge ${kycInfo.badge}`}>{kycInfo.label}</span>
          </div>
          <p style={{ fontSize: '.84rem', color: 'var(--muted)' }}>{kycInfo.desc}</p>
        </div>
        {(kycStatus === 'none' || kycStatus === 'rejected') && (
          <button className="btn btn-sm" style={{ background: 'var(--warn)', color: '#000', whiteSpace: 'nowrap', flexShrink: 0 }}
            onClick={() => setTab('kyc')}>
            {kycStatus === 'rejected' ? 'Re-submit' : 'Verify Now'}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '.3rem', marginBottom: '1.2rem', background: 'var(--surface)', borderRadius: 8, padding: '.3rem' }}>
        {(['profile', 'kyc', 'security'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} className="btn" style={{
            flex: 1, padding: '.5rem', fontSize: '.82rem',
            background: tab === t ? 'var(--bg)' : 'transparent',
            color: tab === t ? 'var(--text)' : 'var(--muted)',
            border: tab === t ? '1px solid var(--border)' : 'none', borderRadius: 6,
          }}>
            {t === 'profile' ? 'Personal Info' : t === 'kyc' ? '🪪 KYC' : '🔐 Security'}
          </button>
        ))}
      </div>

      {tab === 'profile' ? (
        <div>
          {/* Name — read-only */}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div className="grid-2">
              <div className="form-group">
                <label>First Name</label>
                <input value={user?.first_name ?? ''} disabled style={{ opacity: .6 }} />
              </div>
              <div className="form-group">
                <label>Last Name</label>
                <input value={user?.last_name ?? ''} disabled style={{ opacity: .6 }} />
              </div>
            </div>
            <p style={{ fontSize: '.75rem', color: 'var(--muted)', margin: 0 }}>
              Name cannot be changed self-service. Contact{' '}
              <a href="mailto:support@zeehfi.ca" style={{ color: 'var(--accent)' }}>support@zeehfi.ca</a>{' '}
              if your name is incorrect.
            </p>
          </div>

          {/* Editable fields */}
          <form className="card" onSubmit={saveProfile}>
            <div className="form-group">
              <label>Email</label>
              <input value={user?.email ?? ''} disabled style={{ opacity: .5 }} />
            </div>
            <div className="grid-2">
              <div className="form-group">
                <label>Phone</label>
                <input value={profile.phone} onChange={e => setProfile(p => ({ ...p, phone: e.target.value }))} placeholder="+1 416..." />
              </div>
              <div className="form-group">
                <label>Country</label>
                <select value={profile.country} onChange={e => setProfile(p => ({ ...p, country: e.target.value }))}>
                  <option value="">Select…</option>
                  {COUNTRIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <button className="btn btn-primary btn-full" disabled={loading}>
              {loading ? <span className="spinner" /> : 'Save Changes'}
            </button>
          </form>
        </div>

      ) : tab === 'kyc' ? (
        // Gate on kycStatusReady — prevents the stale store value ('none')
        // from flashing KycWizard before the live DB fetch resolves.
        // Also gate on kycPolling — when redirected back from the widget with
        // ?kyc_done=1, show a waiting state until the webhook lands instead of
        // showing the wizard from scratch.
        (!kycStatusReady || kycPolling) ? (
          <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
            <span className="spinner" style={{ marginBottom: '1rem', display: 'block' }} />
            <div style={{ fontSize: '.88rem', color: 'var(--muted)' }}>
              {kycPolling ? 'Processing your verification…' : ''}
            </div>
            {kycPolling && (
              <button
                className="btn btn-sm"
                style={{ marginTop: '1.2rem' }}
                onClick={() => setKycPolling(false)}
              >
                Cancel and try again
              </button>
            )}
          </div>
        ) : kycStatus === 'approved' ? (
          <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
            <div style={{ fontSize: '3.5rem', marginBottom: '.8rem' }}>✅</div>
            <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: '.4rem' }}>Identity Verified</div>
            <div style={{ color: 'var(--muted)', fontSize: '.88rem' }}>All features are unlocked.</div>
          </div>
        ) : kycStatus === 'pending' ? (
          <PendingKycPanel onStatusChange={(s) => updateUser({ kyc_status: s })} />
        ) : (
          <div className="card">
            <KycWizard
              user={{ first_name: user?.first_name ?? '', last_name: user?.last_name ?? '', email: user?.email ?? '' }}
              onComplete={(status) => {
                updateUser({ kyc_status: status });
                if (status === 'approved') {
                  toast('Identity verified! ✅');
                  setTab('profile');
                } else if (status === 'pending') {
                  toast('Verification submitted — under review');
                  setTab('profile');
                } else {
                  // rejected — keep them on the KYC tab so they immediately see
                  // why and can re-submit, instead of bouncing to the profile tab
                  toast('We couldn\'t verify your identity. Please try again.', 'err');
                }
              }}
              onError={msg => toast(msg, 'err')}
            />
          </div>
        )

      ) : (
        /* Security tab */
        <div className="card">
          <div style={{ marginBottom: '1.4rem' }}>
            <div style={{ fontWeight: 600, marginBottom: '.25rem' }}>Transaction PIN</div>
            <div style={{ fontSize: '.84rem', color: 'var(--muted)' }}>
              Required before every send, exchange, or bank transfer.
            </div>
            <div style={{ marginTop: '.5rem' }}>
              <span className={`badge ${hasPin ? 'badge-green' : 'badge-grey'}`}>
                {hasPin ? 'PIN set ✓' : 'Not set'}
              </span>
            </div>
          </div>

          {!hasPin ? (
            <form onSubmit={handleSetPin}>
              <div style={{ fontSize: '.78rem', color: 'var(--muted)', marginBottom: '.8rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>Set your PIN</div>
              <div className="grid-2">
                <div className="form-group">
                  <label>4-digit PIN</label>
                  <input type="password" inputMode="numeric" maxLength={4} required
                    value={setForm.pin} onChange={e => setSetForm(f => ({ ...f, pin: e.target.value.replace(/\D/g,'') }))}
                    placeholder="••••" style={{ textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.3em', fontFamily: 'monospace' }} />
                </div>
                <div className="form-group">
                  <label>Confirm PIN</label>
                  <input type="password" inputMode="numeric" maxLength={4} required
                    value={setForm.confirm} onChange={e => setSetForm(f => ({ ...f, confirm: e.target.value.replace(/\D/g,'') }))}
                    placeholder="••••" style={{ textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.3em', fontFamily: 'monospace' }} />
                </div>
              </div>
              <button className="btn btn-primary btn-full" disabled={pinLoading || setForm.pin.length !== 4 || setForm.confirm.length !== 4}>
                {pinLoading ? <span className="spinner" /> : 'Set PIN'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleChangePin}>
              <div style={{ fontSize: '.78rem', color: 'var(--muted)', marginBottom: '.8rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>Change PIN</div>
              <div className="form-group">
                <label>Current PIN</label>
                <input type="password" inputMode="numeric" maxLength={4} required
                  value={chgForm.current_pin} onChange={e => setChgForm(f => ({ ...f, current_pin: e.target.value.replace(/\D/g,'') }))}
                  placeholder="••••" style={{ textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.3em', fontFamily: 'monospace' }} />
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label>New PIN</label>
                  <input type="password" inputMode="numeric" maxLength={4} required
                    value={chgForm.new_pin} onChange={e => setChgForm(f => ({ ...f, new_pin: e.target.value.replace(/\D/g,'') }))}
                    placeholder="••••" style={{ textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.3em', fontFamily: 'monospace' }} />
                </div>
                <div className="form-group">
                  <label>Confirm New</label>
                  <input type="password" inputMode="numeric" maxLength={4} required
                    value={chgForm.new_confirm} onChange={e => setChgForm(f => ({ ...f, new_confirm: e.target.value.replace(/\D/g,'') }))}
                    placeholder="••••" style={{ textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.3em', fontFamily: 'monospace' }} />
                </div>
              </div>
              <button className="btn btn-primary btn-full" disabled={pinLoading || chgForm.current_pin.length !== 4 || chgForm.new_pin.length !== 4 || chgForm.new_confirm.length !== 4}>
                {pinLoading ? <span className="spinner" /> : 'Change PIN'}
              </button>
            </form>
          )}

          <details style={{ marginTop: '1.4rem', borderTop: '1px solid var(--border)', paddingTop: '1.2rem' }}>
            <summary style={{ fontSize: '.84rem', color: 'var(--muted)', cursor: 'pointer' }}>Forgot your PIN? Reset with password</summary>
            <form onSubmit={handleResetPin} style={{ marginTop: '1rem' }}>
              <div className="form-group">
                <label>Account Password</label>
                <input type="password" required value={rstForm.password} onChange={e => setRstForm(f => ({ ...f, password: e.target.value }))} placeholder="Your login password" />
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label>New PIN</label>
                  <input type="password" inputMode="numeric" maxLength={4} required
                    value={rstForm.new_pin} onChange={e => setRstForm(f => ({ ...f, new_pin: e.target.value.replace(/\D/g,'') }))}
                    placeholder="••••" style={{ textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.3em', fontFamily: 'monospace' }} />
                </div>
                <div className="form-group">
                  <label>Confirm New</label>
                  <input type="password" inputMode="numeric" maxLength={4} required
                    value={rstForm.new_confirm} onChange={e => setRstForm(f => ({ ...f, new_confirm: e.target.value.replace(/\D/g,'') }))}
                    placeholder="••••" style={{ textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.3em', fontFamily: 'monospace' }} />
                </div>
              </div>
              <button className="btn btn-warn btn-full" disabled={pinLoading || !rstForm.password || rstForm.new_pin.length !== 4 || rstForm.new_confirm.length !== 4}>
                {pinLoading ? <span className="spinner" /> : 'Reset PIN'}
              </button>
            </form>
          </details>
        </div>
      )}

      {/* Sign out */}
      <button
        className="btn btn-full"
        style={{ marginTop: '1.5rem', color: 'var(--danger)', borderColor: 'rgba(244,63,94,0.25)', background: 'rgba(244,63,94,0.06)' }}
        onClick={() => { logout(); navigate('/'); }}
      >
        ⏻ &nbsp;Sign out
      </button>
    </div>
  );
}
