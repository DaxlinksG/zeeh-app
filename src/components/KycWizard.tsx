/**
 * KycWizard — embeds kyc.zeehfi.ca/verify as a full-screen iframe.
 *
 * Flow:
 *  1. User taps "Start Verification"
 *  2. Backend creates a session → returns verify_url
 *  3. Full-screen iframe shows the KYC widget (doc capture + liveness)
 *  4. We poll GET /me/profile every 5s to detect completion via webhook
 *  5. On status change → notify parent, iframe closes
 *
 * CORS and X-Frame-Options are open on kyc.zeehfi.ca, so embedding works.
 */

import { useState, useEffect, useRef } from 'react';
import api from '../lib/api';

export interface KycWizardProps {
  user: { first_name: string; last_name: string; email: string };
  onComplete: (status: 'approved' | 'pending') => void;
  onError?: (msg: string) => void;
}

type Step = 'intro' | 'loading' | 'widget' | 'error';

export function KycWizard({ onComplete, onError }: KycWizardProps) {
  const [step,      setStep]      = useState<Step>('intro');
  const [verifyUrl, setVerifyUrl] = useState('');
  const [error,     setError]     = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll profile while the widget is open
  useEffect(() => {
    if (step !== 'widget') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await api.get('/me/profile');
        const status: string = data?.data?.kyc_status ?? 'none';
        if (status === 'approved' || status === 'pending') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          onComplete(status as 'approved' | 'pending');
        }
      } catch { /* retry */ }
    }, 5000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [step, onComplete]);

  async function startKyc() {
    setStep('loading');
    try {
      const { data } = await api.post('/me/kyc/start');
      setVerifyUrl(data.data.verify_url);
      setStep('widget');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? 'Could not start verification. Please try again.';
      setError(msg);
      onError?.(msg);
      setStep('error');
    }
  }

  if (step === 'intro') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
      <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>Identity Verification</div>
      <p style={{ color: 'var(--muted)', fontSize: '.88rem', lineHeight: 1.7, margin: 0 }}>
        We need to verify your identity to unlock bank transfers and currency exchange.
        This takes about 3 minutes.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
        {([
          ['📄', 'A passport, national ID, or driver\'s licence'],
          ['📸', 'Camera for document scan and face check'],
          ['🔒', 'Encrypted and NDPR / FINTRAC compliant'],
        ] as [string, string][]).map(([icon, text]) => (
          <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '.7rem', fontSize: '.86rem', color: 'var(--muted)' }}>
            <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{icon}</span>
            <span>{text}</span>
          </div>
        ))}
      </div>
      <button className="btn btn-primary" style={{ marginTop: '.4rem' }} onClick={startKyc}>
        Start Verification
      </button>
    </div>
  );

  if (step === 'loading') return (
    <div style={{ textAlign: 'center', padding: '2rem 0', display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center', color: 'var(--muted)' }}>
      <span className="spinner" />
      <span style={{ fontSize: '.88rem' }}>Starting verification…</span>
    </div>
  );

  if (step === 'error') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ color: 'var(--danger, #f43f5e)', fontWeight: 600 }}>Could not start verification</div>
      <p style={{ fontSize: '.86rem', color: 'var(--muted)', margin: 0 }}>{error}</p>
      <button className="btn btn-primary" onClick={() => { setError(''); setStep('intro'); }}>Try Again</button>
    </div>
  );

  // Full-screen iframe overlay
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', flexDirection: 'column',
      background: '#fff',
    }}>
      {/* Thin top bar with cancel */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', flexShrink: 0,
        background: 'var(--bg, #07070f)',
        borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))',
      }}>
        <span style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text, #eaeaff)' }}>
          Identity Verification
        </span>
        <button
          onClick={() => setStep('intro')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted, #888)', fontSize: '1.3rem', lineHeight: 1, padding: '4px 8px' }}
          aria-label="Cancel verification"
        >
          ✕
        </button>
      </div>

      <iframe
        src={verifyUrl}
        style={{ flex: 1, border: 'none', display: 'block' }}
        allow="camera; microphone"
        title="Identity Verification"
      />
    </div>
  );
}
