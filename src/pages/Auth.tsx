import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { API_BASE } from '../lib/api';
import { toast } from '../components/Toast';

type Tab = 'login' | 'register';

const COUNTRIES = ['Canada','Nigeria','United States','United Kingdom','Germany','France','Ghana','Kenya','South Africa','Other'];

export default function Auth() {
  const [tab, setTab] = useState<Tab>('login');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setAuth = useAuthStore(s => s.setAuth);

  /* LOGIN */
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPass,  setLoginPass]  = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await axios.post(`${API_BASE}/auth/login`, { email: loginEmail, password: loginPass });
      setAuth(data.data.user, data.data.access_token, data.data.refresh_token);
      navigate('/dashboard');
    } catch (err: unknown) {
      const msg = (axios.isAxiosError(err) && err.response?.data?.message) || 'Login failed';
      toast(msg, 'err');
    } finally { setLoading(false); }
  }

  /* REGISTER */
  const [reg, setReg] = useState({ email: '', password: '', first_name: '', last_name: '', phone: '', country: 'Canada' });

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (reg.password.length < 8) { toast('Password must be at least 8 characters', 'err'); return; }
    setLoading(true);
    try {
      const { data } = await axios.post(`${API_BASE}/auth/register`, reg);
      setAuth(data.data.user, data.data.access_token, data.data.refresh_token);
      navigate('/dashboard');
      toast('Welcome to Zeeh Africa! 🎉');
    } catch (err: unknown) {
      const msg = (axios.isAxiosError(err) && err.response?.data?.message) || 'Registration failed';
      toast(msg, 'err');
    } finally { setLoading(false); }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'var(--bg)' }}>
      <div style={{ width: '100%', maxWidth: 440 }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '.3rem' }}>
            Zeeh <span style={{ color: 'var(--accent2)' }}>Africa</span>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: '.9rem' }}>Send, receive & exchange across borders</div>
        </div>

        <div className="card">
          {/* Tab switcher */}
          <div style={{ display: 'flex', gap: '.3rem', marginBottom: '1.6rem', background: 'var(--bg)', borderRadius: 8, padding: '.3rem' }}>
            {(['login', 'register'] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)} className="btn" style={{
                flex: 1, padding: '.5rem', fontSize: '.88rem',
                background: tab === t ? 'var(--surface)' : 'transparent',
                color: tab === t ? 'var(--text)' : 'var(--muted)',
                border: tab === t ? '1px solid var(--border)' : 'none',
                borderRadius: 6,
              }}>
                {t === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            ))}
          </div>

          {tab === 'login' ? (
            <form onSubmit={handleLogin}>
              <div className="form-group">
                <label>Email</label>
                <input type="email" required value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="form-group">
                <label>Password</label>
                <input type="password" required value={loginPass} onChange={e => setLoginPass(e.target.value)} placeholder="••••••••" />
              </div>
              <button className="btn btn-primary btn-full" disabled={loading} style={{ marginTop: '.5rem' }}>
                {loading ? <span className="spinner" /> : 'Sign In'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleRegister}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
                <div className="form-group">
                  <label>First Name</label>
                  <input required value={reg.first_name} onChange={e => setReg(r => ({ ...r, first_name: e.target.value }))} placeholder="Jane" />
                </div>
                <div className="form-group">
                  <label>Last Name</label>
                  <input required value={reg.last_name} onChange={e => setReg(r => ({ ...r, last_name: e.target.value }))} placeholder="Doe" />
                </div>
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" required value={reg.email} onChange={e => setReg(r => ({ ...r, email: e.target.value }))} placeholder="you@example.com" />
              </div>
              <div className="form-group">
                <label>Password</label>
                <input type="password" required value={reg.password} onChange={e => setReg(r => ({ ...r, password: e.target.value }))} placeholder="Min. 8 characters" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
                <div className="form-group">
                  <label>Phone</label>
                  <input required value={reg.phone} onChange={e => setReg(r => ({ ...r, phone: e.target.value }))} placeholder="+1 416 000 0000" />
                </div>
                <div className="form-group">
                  <label>Country</label>
                  <select value={reg.country} onChange={e => setReg(r => ({ ...r, country: e.target.value }))}>
                    {COUNTRIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <button className="btn btn-success btn-full" disabled={loading} style={{ marginTop: '.5rem' }}>
                {loading ? <span className="spinner" /> : 'Create Account'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
