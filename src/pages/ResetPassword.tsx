import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE } from '../lib/api';
import { toast } from '../components/Toast';

export default function ResetPassword() {
  const [params]   = useSearchParams();
  const navigate   = useNavigate();
  const uid        = params.get('uid')   ?? '';
  const token      = params.get('token') ?? '';

  const [password,  setPassword]  = useState('');
  const [confirm,   setConfirm]   = useState('');
  const [loading,   setLoading]   = useState(false);
  const [done,      setDone]      = useState(false);

  // Invalid link — uid or token missing
  if (!uid || !token) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'var(--bg)' }}>
        <div className="card" style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: '.8rem' }}>⚠️</div>
          <div style={{ fontWeight: 700, marginBottom: '.5rem' }}>Invalid reset link</div>
          <div style={{ color: 'var(--muted)', fontSize: '.88rem', marginBottom: '1.5rem' }}>
            This link is missing required parameters. Please request a new password reset.
          </div>
          <button className="btn btn-primary btn-full" onClick={() => navigate('/')}>Back to sign in</button>
        </div>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { toast('Password must be at least 8 characters', 'err'); return; }
    if (password !== confirm) { toast('Passwords do not match', 'err'); return; }
    setLoading(true);
    try {
      await axios.post(`${API_BASE}/auth/reset-password`, { user_id: uid, token, new_password: password });
      setDone(true);
    } catch (err: unknown) {
      const status = axios.isAxiosError(err) ? err.response?.status : 0;
      if (status === 410) toast('This reset link has expired. Please request a new one.', 'err');
      else if (status === 400) toast('Invalid reset link. Please request a new one.', 'err');
      else toast((axios.isAxiosError(err) && err.response?.data?.message) || 'Something went wrong. Please try again.', 'err');
    } finally { setLoading(false); }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'var(--bg)' }}>
      <div style={{ width: '100%', maxWidth: 420 }}>

        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '.3rem' }}>
            Zeeh <span style={{ color: 'var(--accent2)' }}>Africa</span>
          </div>
        </div>

        <div className="card">
          {done ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '.8rem' }}>✅</div>
              <div style={{ fontWeight: 700, marginBottom: '.5rem' }}>Password updated</div>
              <div style={{ color: 'var(--muted)', fontSize: '.88rem', marginBottom: '1.5rem' }}>
                Your password has been changed. Sign in with your new password.
              </div>
              <button className="btn btn-primary btn-full" onClick={() => navigate('/')}>
                Sign in
              </button>
            </div>
          ) : (
            <>
              <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                <div style={{ fontSize: '2rem', marginBottom: '.4rem' }}>🔑</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '.3rem' }}>Set a new password</div>
                <div style={{ color: 'var(--muted)', fontSize: '.88rem' }}>Choose a strong password for your account.</div>
              </div>
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>New password</label>
                  <input
                    type="password" required minLength={8}
                    value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                  />
                </div>
                <div className="form-group">
                  <label>Confirm new password</label>
                  <input
                    type="password" required
                    value={confirm} onChange={e => setConfirm(e.target.value)}
                    placeholder="Repeat your new password"
                  />
                </div>
                <button className="btn btn-primary btn-full" disabled={loading || password.length < 8 || password !== confirm} style={{ marginTop: '.5rem' }}>
                  {loading ? <span className="spinner" /> : 'Update password'}
                </button>
              </form>
            </>
          )}
        </div>

      </div>
    </div>
  );
}
