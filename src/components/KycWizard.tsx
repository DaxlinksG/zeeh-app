/**
 * KycWizard — delegates identity verification to the standalone KYC service
 * at kyc.zeehfi.ca.
 *
 * Flow:
 *  1. User taps "Start Verification"
 *  2. Backend creates a KYC session (POST /me/kyc/start) and returns a widget_url
 *  3. Widget is shown full-screen in an iframe (camera + liveness handled by the service)
 *  4. We poll GET /me/profile every 5 s; when kyc_status changes we notify the parent
 *  5. Parent (Profile.tsx) updates auth store and switches tabs
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
  const [widgetUrl, setWidgetUrl] = useState('');
  const [error,     setError]     = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll /me/profile while the widget is open so we detect completion via webhook
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
      } catch { /* network hiccup — retry next tick */ }
    }, 5000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [step, onComplete]);

  const startKyc = async () => {
    setStep('loading');
    try {
      const { data } = await api.post('/me/kyc/start');
      setWidgetUrl(data.data.widget_url);
      setStep('widget');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? 'Could not start verification. Please try again.';
      setError(msg);
      onError?.(msg);
      setStep('error');
    }
  };

  // ── Intro ──────────────────────────────────────────────────────────────────
  if (step === 'intro') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
      <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>Identity Verification</div>
      <p style={{ color: 'var(--muted)', fontSize: '.88rem', lineHeight: 1.6, margin: 0 }}>
        To comply with regulations and protect our users, we need to verify your identity.
        This takes about 3 minutes.
      </p>
      <ul style={{ color: 'var(--muted)', fontSize: '.85rem', lineHeight: 2, paddingLeft: '1.2rem', margin: 0 }}>
        <li>📄 A physical ID, passport, or driver's licence</li>
        <li>📸 Front-facing camera for a liveness check</li>
        <li>🏠 Optionally: a recent proof-of-address document</li>
      </ul>
      <p style={{ color: 'var(--muted)', fontSize: '.78rem', margin: 0 }}>
        Your data is encrypted and handled in compliance with NDPR / FINTRAC.
      </p>
      <button className="btn btn-primary" style={{ marginTop: '.4rem' }} onClick={startKyc}>
        Start Verification
      </button>
    </div>
  );

  // ── Loading ────────────────────────────────────────────────────────────────
  if (step === 'loading') return (
    <div style={{ textAlign: 'center', padding: '2.5rem 0', color: 'var(--muted)', fontSize: '.9rem' }}>
      Starting verification…
    </div>
  );

  // ── Error ──────────────────────────────────────────────────────────────────
  if (step === 'error') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ color: 'var(--error, #ff4d6d)', fontWeight: 600 }}>Could not start verification</div>
      <p style={{ color: 'var(--muted)', fontSize: '.88rem', margin: 0 }}>{error}</p>
      <button className="btn btn-primary" onClick={startKyc}>Try Again</button>
    </div>
  );

  // ── Widget (full-screen iframe) ────────────────────────────────────────────
  // Covers the entire viewport. The KYC service widget handles document capture,
  // selfie / liveness, and address upload. We detect completion via polling above.
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', flexDirection: 'column',
      background: '#fff',
    }}>
      {/* Thin close bar so the user can always back out */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        padding: '10px 16px', background: 'var(--bg, #0f1117)',
        borderBottom: '1px solid var(--border, #2a2d3a)',
        flexShrink: 0,
      }}>
        <button
          onClick={() => setStep('intro')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--muted, #888)', fontSize: '1.3rem', lineHeight: 1,
            padding: '4px 8px',
          }}
          aria-label="Cancel verification"
        >
          ✕
        </button>
      </div>

      <iframe
        src={widgetUrl}
        style={{ flex: 1, border: 'none', display: 'block' }}
        allow="camera; microphone"
        title="Identity Verification"
      />
    </div>
  );
}
