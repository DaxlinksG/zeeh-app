import { useEffect, useState } from 'react';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { toast } from '../components/Toast';

type KycStatus = 'none' | 'pending' | 'approved' | 'rejected';

const KYC_STATUS_INFO: Record<KycStatus, { label: string; badge: string; desc: string }> = {
  none:     { label: 'Not Verified',  badge: 'badge-grey',  desc: 'Submit your documents to enable bank transfers and currency exchange.' },
  pending:  { label: 'Under Review',  badge: 'badge-warn',  desc: 'Your KYC submission is being reviewed. This usually takes up to 24 hours.' },
  approved: { label: 'Verified',      badge: 'badge-green', desc: 'Your identity has been verified. All features are unlocked.' },
  rejected: { label: 'Rejected',      badge: 'badge-red',   desc: 'Your KYC was not approved. Please re-submit with correct information.' },
};

const COUNTRIES = ['Canada','Nigeria','United States','United Kingdom','Germany','France','Ghana','Kenya','South Africa','Other'];
const ID_TYPES = [
  { value: 'passport',         label: 'Passport' },
  { value: 'drivers_license',  label: "Driver's License" },
  { value: 'national_id',      label: 'National ID' },
];

type Tab = 'profile' | 'kyc' | 'security';

export default function Profile() {
  const { user, updateUser } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [tab,     setTab]     = useState<Tab>('profile');

  // Profile form
  const [profile, setProfile] = useState({ first_name: user?.first_name ?? '', last_name: user?.last_name ?? '', phone: '', country: '' });

  // KYC form
  const [kyc, setKyc] = useState({
    date_of_birth: '', nationality: '', id_type: 'passport', id_number: '',
    address: { street: '', city: '', state: '', country: '', postal_code: '' },
  });

  // Security / PIN
  const [hasPin,    setHasPin]    = useState(false);
  const [pinLoading, setPinLoading] = useState(false);
  // First-time set
  const [setForm,   setSetForm]   = useState({ pin: '', confirm: '' });
  // Change existing PIN
  const [chgForm,   setChgForm]   = useState({ current_pin: '', new_pin: '', new_confirm: '' });
  // Reset via password
  const [rstForm,   setRstForm]   = useState({ password: '', new_pin: '', new_confirm: '' });

  // Load full profile — also syncs kyc_status, email_verified, and has_pin into the store
  useEffect(() => {
    api.get('/me/profile').then(r => {
      const u = r.data.data;
      setProfile({ first_name: u.first_name, last_name: u.last_name, phone: u.phone ?? '', country: u.country ?? '' });
      updateUser({ kyc_status: u.kyc_status, email_verified: u.email_verified });
      setHasPin(u.has_pin ?? false);
    }).catch(() => {});
  }, [updateUser]);

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

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.put('/me/profile', profile);
      updateUser({ first_name: profile.first_name, last_name: profile.last_name });
      toast('Profile updated');
    } catch { toast('Update failed', 'err'); }
    finally { setLoading(false); }
  }

  async function submitKyc(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/me/kyc', kyc);
      updateUser({ kyc_status: 'pending' });
      toast('KYC submitted! We will review within 24 hours.');
      setKycTab(false);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Submission failed';
      toast(msg, 'err');
    } finally { setLoading(false); }
  }

  const kycStatus = (user?.kyc_status ?? 'none') as KycStatus;
  const kycInfo   = KYC_STATUS_INFO[kycStatus];

  return (
    <div style={{ maxWidth: 560 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '1.6rem' }}>Profile & KYC</h1>

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
            {kycStatus === 'rejected' ? 'Re-submit' : 'Start KYC'}
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
            {t === 'profile' ? 'Personal Info' : t === 'kyc' ? 'KYC Docs' : '🔐 Security'}
          </button>
        ))}
      </div>

      {tab === 'profile' ? (
        <form className="card" onSubmit={saveProfile}>
          <div className="grid-2">
            <div className="form-group">
              <label>First Name</label>
              <input value={profile.first_name} onChange={e => setProfile(p => ({ ...p, first_name: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Last Name</label>
              <input value={profile.last_name} onChange={e => setProfile(p => ({ ...p, last_name: e.target.value }))} />
            </div>
          </div>
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
      ) : tab === 'kyc' ? (
        <form className="card" onSubmit={submitKyc}>
          {kycStatus === 'approved' ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--accent2)' }}>
              <div style={{ fontSize: '3rem', marginBottom: '.6rem' }}>✅</div>
              <div style={{ fontWeight: 600 }}>Identity Verified</div>
              <div style={{ color: 'var(--muted)', fontSize: '.85rem', marginTop: '.3rem' }}>All features are unlocked.</div>
            </div>
          ) : kycStatus === 'pending' ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--warn)' }}>
              <div style={{ fontSize: '3rem', marginBottom: '.6rem' }}>⏳</div>
              <div style={{ fontWeight: 600 }}>Under Review</div>
              <div style={{ color: 'var(--muted)', fontSize: '.85rem', marginTop: '.3rem' }}>We'll notify you when it's done.</div>
            </div>
          ) : (
            <>
              <div className="grid-2">
                <div className="form-group">
                  <label>Date of Birth</label>
                  <input type="date" required value={kyc.date_of_birth} onChange={e => setKyc(k => ({ ...k, date_of_birth: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Nationality</label>
                  <input required value={kyc.nationality} onChange={e => setKyc(k => ({ ...k, nationality: e.target.value }))} placeholder="Canadian" />
                </div>
              </div>

              <div className="grid-2">
                <div className="form-group">
                  <label>ID Type</label>
                  <select value={kyc.id_type} onChange={e => setKyc(k => ({ ...k, id_type: e.target.value }))}>
                    {ID_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>ID Number</label>
                  <input required value={kyc.id_number} onChange={e => setKyc(k => ({ ...k, id_number: e.target.value }))} placeholder="AB123456" />
                </div>
              </div>

              <div style={{ fontSize: '.8rem', color: 'var(--muted)', marginBottom: '.8rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>Address</div>
              <div className="form-group">
                <label>Street</label>
                <input required value={kyc.address.street} onChange={e => setKyc(k => ({ ...k, address: { ...k.address, street: e.target.value } }))} placeholder="123 Main St" />
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label>City</label>
                  <input required value={kyc.address.city} onChange={e => setKyc(k => ({ ...k, address: { ...k.address, city: e.target.value } }))} />
                </div>
                <div className="form-group">
                  <label>State / Province</label>
                  <input required value={kyc.address.state} onChange={e => setKyc(k => ({ ...k, address: { ...k.address, state: e.target.value } }))} />
                </div>
                <div className="form-group">
                  <label>Country</label>
                  <input required value={kyc.address.country} onChange={e => setKyc(k => ({ ...k, address: { ...k.address, country: e.target.value } }))} />
                </div>
                <div className="form-group">
                  <label>Postal Code</label>
                  <input required value={kyc.address.postal_code} onChange={e => setKyc(k => ({ ...k, address: { ...k.address, postal_code: e.target.value } }))} />
                </div>
              </div>

              <button className="btn btn-success btn-full" disabled={loading}>
                {loading ? <span className="spinner" /> : 'Submit for Review'}
              </button>
            </>
          )}
        </form>
      ) : (
        /* ── Security tab ── */
        <div className="card">
          <div style={{ marginBottom: '1.4rem' }}>
            <div style={{ fontWeight: 600, marginBottom: '.25rem' }}>Transaction PIN</div>
            <div style={{ fontSize: '.84rem', color: 'var(--muted)' }}>
              Required before every send, exchange, or bank transfer.
            </div>
            <div style={{ marginTop: '.5rem', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
              <span className={`badge ${hasPin ? 'badge-green' : 'badge-grey'}`}>
                {hasPin ? 'PIN set ✓' : 'Not set'}
              </span>
            </div>
          </div>

          {!hasPin ? (
            /* First-time setup */
            <form onSubmit={handleSetPin}>
              <div style={{ fontSize: '.78rem', color: 'var(--muted)', marginBottom: '.8rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Set your PIN
              </div>
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
            /* Change PIN */
            <form onSubmit={handleChangePin}>
              <div style={{ fontSize: '.78rem', color: 'var(--muted)', marginBottom: '.8rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Change PIN
              </div>
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

          {/* Reset via password */}
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
    </div>
  );
}
