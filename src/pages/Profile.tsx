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

export default function Profile() {
  const { user, updateUser } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [kycTab,  setKycTab]  = useState(false);

  // Profile form
  const [profile, setProfile] = useState({ first_name: user?.first_name ?? '', last_name: user?.last_name ?? '', phone: '', country: '' });

  // KYC form
  const [kyc, setKyc] = useState({
    date_of_birth: '', nationality: '', id_type: 'passport', id_number: '',
    address: { street: '', city: '', state: '', country: '', postal_code: '' },
  });

  // Load full profile — also syncs kyc_status and email_verified into the store
  // so admin approvals are reflected without requiring a logout/login.
  useEffect(() => {
    api.get('/me/profile').then(r => {
      const u = r.data.data;
      setProfile({ first_name: u.first_name, last_name: u.last_name, phone: u.phone ?? '', country: u.country ?? '' });
      // Sync any server-side changes (KYC approval, email verification) back to the store
      updateUser({ kyc_status: u.kyc_status, email_verified: u.email_verified });
    }).catch(() => {});
  }, [updateUser]);

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
            onClick={() => setKycTab(true)}>
            {kycStatus === 'rejected' ? 'Re-submit' : 'Start KYC'}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '.3rem', marginBottom: '1.2rem', background: 'var(--surface)', borderRadius: 8, padding: '.3rem' }}>
        {[false, true].map(isKyc => (
          <button key={String(isKyc)} onClick={() => setKycTab(isKyc)} className="btn" style={{
            flex: 1, padding: '.5rem', fontSize: '.88rem',
            background: kycTab === isKyc ? 'var(--bg)' : 'transparent',
            color: kycTab === isKyc ? 'var(--text)' : 'var(--muted)',
            border: kycTab === isKyc ? '1px solid var(--border)' : 'none', borderRadius: 6,
          }}>
            {isKyc ? 'KYC Documents' : 'Personal Info'}
          </button>
        ))}
      </div>

      {!kycTab ? (
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
      ) : (
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
      )}
    </div>
  );
}
