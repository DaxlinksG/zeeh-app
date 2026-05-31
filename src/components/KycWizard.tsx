/**
 * KycWizard — redirects to kyc.zeehfi.ca/verify for the full hosted KYC flow.
 *
 * Flow:
 *  1. User taps "Start Verification"
 *  2. Backend creates a session (POST /me/kyc/start) → returns verify_url
 *  3. We navigate window.location.href to the verify URL
 *  4. kyc.zeehfi.ca handles doc capture, liveness check, processing
 *  5. On completion, redirects back to /profile?kyc_done=1
 *  6. Profile detects kyc_done param, polls status, shows result toast
 */

import { useState } from 'react';
import api from '../lib/api';

export interface KycWizardProps {
  user: { first_name: string; last_name: string; email: string };
  onComplete: (status: 'approved' | 'pending') => void;
  onError?: (msg: string) => void;
}

type Step = 'intro' | 'loading' | 'error';

export function KycWizard({ onError }: KycWizardProps) {
  const [step,  setStep]  = useState<Step>('intro');
  const [error, setError] = useState('');

  async function startKyc() {
    setStep('loading');
    try {
      const { data } = await api.post('/me/kyc/start');
      // Navigate to the hosted KYC widget — handles doc capture + liveness natively
      window.location.href = data.data.verify_url;
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
          ['📸', 'Camera access for document and face scan'],
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
      <span style={{ fontSize: '.88rem' }}>Opening verification…</span>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ color: 'var(--danger, #f43f5e)', fontWeight: 600 }}>Could not start verification</div>
      <p style={{ fontSize: '.86rem', color: 'var(--muted)', margin: 0 }}>{error}</p>
      <button className="btn btn-primary" onClick={() => { setError(''); setStep('intro'); }}>Try Again</button>
    </div>
  );
}
