import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { API_BASE } from '../lib/api';
import { toast } from '../components/Toast';

type Tab    = 'login' | 'register';
type Screen = 'auth' | 'verify-email' | 'forgot-password' | 'forgot-sent';

const COUNTRIES = ['Canada','Nigeria','United States','United Kingdom','Germany','France','Ghana','Kenya','South Africa','Other'];

export default function Auth() {
  const [tab,    setTab]    = useState<Tab>('login');
  const [screen, setScreen] = useState<Screen>('auth');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setAuth     = useAuthStore(s => s.setAuth);
  const updateUser  = useAuthStore(s => s.updateUser);
  const accessToken = useAuthStore(s => s.accessToken);

  /* ── LOGIN ────────────────────────────────────────────────────────────── */
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

  /* ── REGISTER ─────────────────────────────────────────────────────────── */
  const [reg, setReg] = useState({ email: '', password: '', first_name: '', last_name: '', phone: '', country: 'Canada' });

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (reg.password.length < 8) { toast('Password must be at least 8 characters', 'err'); return; }
    setLoading(true);
    try {
      const { data } = await axios.post(`${API_BASE}/auth/register`, reg);
      setAuth(data.data.user, data.data.access_token, data.data.refresh_token);
      toast('Account created! Check your email for a verification code.');
      setScreen('verify-email');
    } catch (err: unknown) {
      const msg = (axios.isAxiosError(err) && err.response?.data?.message) || 'Registration failed';
      toast(msg, 'err');
    } finally { setLoading(false); }
  }

  /* ── FORGOT PASSWORD ─────────────────────────────────────────────────── */
  const [forgotEmail,  setForgotEmail]  = useState('');
  const [forgotSentTo, setForgotSentTo] = useState('');

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await axios.post(`${API_BASE}/auth/forgot-password`, { email: forgotEmail });
      setForgotSentTo(forgotEmail);
      setScreen('forgot-sent');
    } catch {
      // API always returns 200 to prevent user enumeration — genuine network errors land here
      toast('Something went wrong. Please check your connection and try again.', 'err');
    } finally { setLoading(false); }
  }

  /* ── VERIFY EMAIL ─────────────────────────────────────────────────────── */
  const [otp, setOtp] = useState('');

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken) { toast('Session expired. Please log in again.', 'err'); setScreen('auth'); return; }
    setLoading(true);
    try {
      await axios.post(
        `${API_BASE}/auth/verify-email`,
        { otp: otp.replace(/\s/g, '') },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      updateUser({ email_verified: true });
      toast('Email verified! 🎉');
      navigate('/dashboard');
    } catch (err: unknown) {
      const status = axios.isAxiosError(err) ? err.response?.status : 0;
      if (status === 429) toast('Too many attempts. Request a new code.', 'err');
      else if (status === 410) toast('Code has expired. Request a new one.', 'err');
      else toast((axios.isAxiosError(err) && err.response?.data?.message) || 'Incorrect code', 'err');
    } finally { setLoading(false); }
  }

  async function handleResendOtp() {
    if (!accessToken) { toast('Session expired. Please log in again.', 'err'); return; }
    try {
      await axios.post(`${API_BASE}/auth/resend-otp`, {}, { headers: { Authorization: `Bearer ${accessToken}` } });
      toast('New code sent — check your email.');
    } catch (err: unknown) {
      const msg = (axios.isAxiosError(err) && err.response?.data?.message) || 'Could not resend code. Please try again.';
      toast(msg, 'err');
    }
  }

  /* ── SHARED SHELL ─────────────────────────────────────────────────────── */
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'var(--bg)' }}>
      <div style={{ width: '100%', maxWidth: 440 }}>

        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '.3rem' }}>
            Zeeh <span style={{ color: 'var(--accent2)' }}>Africa</span>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: '.9rem' }}>Send, receive &amp; exchange across borders</div>
        </div>

        {/* ── Forgot password — enter email ────────────────────────────── */}
        {screen === 'forgot-password' ? (
          <div className="card">
            <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '2.2rem', marginBottom: '.4rem' }}>🔑</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '.3rem' }}>Reset your password</div>
              <div style={{ color: 'var(--muted)', fontSize: '.88rem' }}>Enter your email and we'll send a reset link if an account exists.</div>
            </div>
            <form onSubmit={handleForgotPassword}>
              <div className="form-group">
                <label>Email address</label>
                <input type="email" required value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <button className="btn btn-primary btn-full" disabled={loading} style={{ marginTop: '.5rem' }}>
                {loading ? <span className="spinner" /> : 'Send reset link'}
              </button>
            </form>
            <div style={{ textAlign: 'center', marginTop: '1.2rem', fontSize: '.85rem' }}>
              <button onClick={() => setScreen('auth')} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '.85rem' }}>
                ← Back to sign in
              </button>
            </div>
          </div>

        ) : screen === 'forgot-sent' ? (
          <div className="card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '.8rem' }}>📬</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '.5rem' }}>Check your inbox</div>
            <div style={{ color: 'var(--muted)', fontSize: '.88rem', marginBottom: '1.5rem', lineHeight: 1.5 }}>
              If <strong style={{ color: 'var(--text)' }}>{forgotSentTo}</strong> is registered, you'll receive a password reset link shortly. Check your spam folder if you don't see it.
            </div>
            <button className="btn btn-primary btn-full" onClick={() => { setScreen('auth'); setForgotEmail(''); }}>
              Back to sign in
            </button>
          </div>

        ) : screen === 'verify-email' ? (
          <div className="card">
            <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '.5rem' }}>📧</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '.4rem' }}>Check your email</div>
              <div style={{ color: 'var(--muted)', fontSize: '.88rem' }}>
                We sent a 6-digit code to <strong style={{ color: 'var(--text)' }}>{reg.email || 'your email'}</strong>.
                Enter it below to verify your account.
              </div>
            </div>

            <form onSubmit={handleVerify}>
              <div className="form-group">
                <label>Verification code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={otp}
                  onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                  style={{ textAlign: 'center', fontSize: '1.6rem', letterSpacing: '0.3em', fontFamily: 'monospace' }}
                  required
                />
              </div>
              <button className="btn btn-primary btn-full" disabled={loading || otp.length !== 6} style={{ marginTop: '.5rem' }}>
                {loading ? <span className="spinner" /> : 'Verify email'}
              </button>
            </form>

            <div style={{ textAlign: 'center', marginTop: '1.2rem', fontSize: '.85rem', color: 'var(--muted)' }}>
              Didn't get the code?{' '}
              <button onClick={handleResendOtp} className="btn" style={{ padding: '0', background: 'none', border: 'none', color: 'var(--accent)', fontSize: '.85rem', fontWeight: 600, cursor: 'pointer' }}>
                Resend
              </button>
            </div>

            <div style={{ textAlign: 'center', marginTop: '.6rem', fontSize: '.82rem', color: 'var(--muted)' }}>
              <button onClick={() => { setScreen('auth'); navigate('/dashboard'); }} className="btn" style={{ padding: '0', background: 'none', border: 'none', color: 'var(--muted)', fontSize: '.82rem', cursor: 'pointer' }}>
                Skip for now →
              </button>
            </div>
          </div>
        ) : (

        /* ── Login / Register screen ──────────────────────────────────── */
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
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Password</span>
                  <button type="button" onClick={() => { setForgotEmail(loginEmail); setScreen('forgot-password'); }} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '.8rem', cursor: 'pointer', padding: 0, fontWeight: 500 }}>
                    Forgot password?
                  </button>
                </label>
                <input type="password" required value={loginPass} onChange={e => setLoginPass(e.target.value)} placeholder="••••••••" />
              </div>
              <button className="btn btn-primary btn-full" disabled={loading} style={{ marginTop: '.5rem' }}>
                {loading ? <span className="spinner" /> : 'Sign In'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleRegister}>
              <div className="grid-2">
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
              <div className="grid-2">
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
        )}
      </div>
    </div>
  );
}
