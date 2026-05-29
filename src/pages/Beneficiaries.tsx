import { useState, useEffect } from 'react';
import api from '../lib/api';
import { toast } from '../components/Toast';

interface Beneficiary {
  beneficiary_id: string;
  email:          string;
  first_name:     string;
  last_name:      string;
  added_at:       string;
}

export default function Beneficiaries() {
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [addOpen,       setAddOpen]       = useState(false);
  const [searchEmail,   setSearchEmail]   = useState('');
  const [searchResult,  setSearchResult]  = useState<{ user_id: string; first_name: string; last_name: string; email: string } | null>(null);
  const [searching,     setSearching]     = useState(false);
  const [adding,        setAdding]        = useState(false);
  const [removing,      setRemoving]      = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const { data } = await api.get('/me/beneficiaries');
      setBeneficiaries(data.data?.beneficiaries ?? []);
    } catch { toast('Failed to load beneficiaries', 'err'); }
    finally  { setLoading(false); }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    setSearchResult(null);
    try {
      const { data } = await api.get(`/me/users/search?email=${encodeURIComponent(searchEmail)}`);
      const already = beneficiaries.some(b => b.beneficiary_id === data.data.user_id);
      if (already) { toast('Already in your beneficiaries', 'err'); return; }
      setSearchResult(data.data);
    } catch { toast('No Zeeh user found with that email', 'err'); }
    finally  { setSearching(false); }
  }

  async function handleAdd() {
    if (!searchResult) return;
    setAdding(true);
    try {
      await api.post('/me/beneficiaries', { email: searchResult.email });
      toast(`${searchResult.first_name} saved as beneficiary ✅`);
      setBeneficiaries(prev => [...prev, {
        beneficiary_id: searchResult!.user_id,
        email:          searchResult!.email,
        first_name:     searchResult!.first_name,
        last_name:      searchResult!.last_name,
        added_at:       new Date().toISOString(),
      }].sort((a, b) => a.first_name.localeCompare(b.first_name)));
      setAddOpen(false);
      setSearchEmail('');
      setSearchResult(null);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Failed to add';
      toast(msg, 'err');
    } finally { setAdding(false); }
  }

  async function handleRemove(b: Beneficiary) {
    if (!confirm(`Remove ${b.first_name} ${b.last_name} from your beneficiaries?`)) return;
    setRemoving(b.beneficiary_id);
    try {
      await api.delete(`/me/beneficiaries/${b.beneficiary_id}`);
      setBeneficiaries(prev => prev.filter(x => x.beneficiary_id !== b.beneficiary_id));
      toast('Beneficiary removed');
    } catch { toast('Could not remove', 'err'); }
    finally  { setRemoving(null); }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.6rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Beneficiaries</h1>
          <p style={{ color: 'var(--muted)', fontSize: '.84rem', marginTop: '.25rem' }}>
            You can only send money to saved beneficiaries.
          </p>
        </div>
        <button className="btn btn-primary btn-sm" style={{ flexShrink: 0 }} onClick={() => setAddOpen(true)}>
          + Add
        </button>
      </div>

      {/* Add modal */}
      {addOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}>
          <div className="card" style={{ width: '100%', maxWidth: 420 }}>
            <div style={{ fontWeight: 700, fontSize: '1.05rem', marginBottom: '1.2rem' }}>Add Beneficiary</div>

            <form onSubmit={handleSearch}>
              <div className="form-group">
                <label>Email address</label>
                <input
                  type="email" required autoFocus
                  value={searchEmail}
                  onChange={e => { setSearchEmail(e.target.value); setSearchResult(null); }}
                  placeholder="friend@example.com"
                />
              </div>
              <button className="btn btn-primary btn-full" disabled={searching}>
                {searching ? <span className="spinner" /> : 'Find Person'}
              </button>
            </form>

            {searchResult && (
              <div style={{ marginTop: '1.2rem', padding: '1rem', background: 'rgba(0,212,170,.06)', border: '1px solid rgba(0,212,170,.25)', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.8rem' }}>
                    <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--accent)', display: 'grid', placeItems: 'center', fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                      {searchResult.first_name[0].toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600 }}>{searchResult.first_name} {searchResult.last_name}</div>
                      <div style={{ fontSize: '.8rem', color: 'var(--muted)' }}>{searchResult.email}</div>
                    </div>
                  </div>
                  <button className="btn btn-success btn-sm" style={{ flexShrink: 0 }} onClick={handleAdd} disabled={adding}>
                    {adding ? <span className="spinner" /> : 'Save'}
                  </button>
                </div>
              </div>
            )}

            <button className="btn btn-ghost btn-full" style={{ marginTop: '1rem' }} onClick={() => { setAddOpen(false); setSearchEmail(''); setSearchResult(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem' }}><span className="spinner spinner-lg" /></div>
      ) : beneficiaries.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '.8rem' }}>👥</div>
          <div style={{ fontWeight: 500, marginBottom: '.4rem' }}>No beneficiaries yet</div>
          <div style={{ fontSize: '.84rem' }}>
            Add someone's email above before you can send them money.
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {beneficiaries.map((b, i) => (
            <div key={b.beneficiary_id} style={{
              display: 'flex', alignItems: 'center', gap: '1rem',
              padding: '1rem 1.2rem',
              borderBottom: i < beneficiaries.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent)', display: 'grid', placeItems: 'center', fontSize: '1rem', fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                {b.first_name[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{b.first_name} {b.last_name}</div>
                <div style={{ fontSize: '.8rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.email}</div>
              </div>
              <button
                className="btn btn-sm"
                style={{ color: 'var(--danger)', border: '1px solid var(--danger)', background: 'transparent', flexShrink: 0 }}
                disabled={removing === b.beneficiary_id}
                onClick={() => handleRemove(b)}
              >
                {removing === b.beneficiary_id ? <span className="spinner" /> : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
