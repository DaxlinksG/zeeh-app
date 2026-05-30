/**
 * KycWizard — native identity verification flow.
 *
 * Steps:
 *   intro → doc_type → doc_front → doc_back* → selfie → uploading → submitted
 *   (* doc_back only for NATIONAL_ID and DRIVERS_LICENSE)
 *
 * Images are compressed client-side then uploaded via the backend proxy
 * (POST /me/kyc/upload-doc and /me/kyc/upload-selfie) which forwards them
 * to kyc.zeehfi.ca using the session_token. Status is driven by webhook →
 * parent polls GET /me/profile for the final kyc_status change.
 */

import { useState, useRef, useCallback } from 'react';
import api from '../lib/api';

export interface KycWizardProps {
  user: { first_name: string; last_name: string; email: string };
  onComplete: (status: 'approved' | 'pending') => void;
  onError?: (msg: string) => void;
}

type DocType = 'PASSPORT' | 'NATIONAL_ID' | 'DRIVERS_LICENSE';
type Step    = 'intro' | 'doc_type' | 'doc_front' | 'doc_back' | 'selfie' | 'uploading' | 'submitted' | 'error';

const DOC_LABELS: Record<DocType, string> = {
  PASSPORT:         '🛂 Passport',
  NATIONAL_ID:      '🪪 National ID',
  DRIVERS_LICENSE:  '🚗 Driver\'s Licence',
};

const STEP_LABELS: Partial<Record<Step, string>> = {
  doc_type:  'Document',
  doc_front: 'ID Photo',
  doc_back:  'ID Back',
  selfie:    'Selfie',
};

// ── Image compression ──────────────────────────────────────────────────────
async function compressImage(file: File, maxW = 1100, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale  = Math.min(1, maxW / img.width);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

// ── Shared components ──────────────────────────────────────────────────────
function ProgressBar({ step, docType }: { step: Step; docType: DocType | null }) {
  const steps: Step[] = ['doc_type', 'doc_front',
    ...(docType && docType !== 'PASSPORT' ? ['doc_back' as Step] : []),
    'selfie',
  ];
  const idx = steps.indexOf(step);
  if (idx < 0) return null;
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: '1.5rem' }}>
      {steps.map((s, i) => (
        <div key={s} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
          <div style={{
            height: 3, width: '100%', borderRadius: 99,
            background: i <= idx ? 'var(--accent)' : 'var(--border)',
            transition: 'background .3s',
          }} />
          <span style={{ fontSize: '.65rem', color: i <= idx ? 'var(--accent)' : 'var(--muted)' }}>
            {STEP_LABELS[s]}
          </span>
        </div>
      ))}
    </div>
  );
}

function CaptureButton({
  label, hint, capture, onCapture, preview, loading,
}: {
  label: string; hint: string; capture: 'environment' | 'user';
  onCapture: (b64: string) => void; preview: string | null; loading: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const b64 = await compressImage(file);
    onCapture(b64);
    e.target.value = '';
  }, [onCapture]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={capture}
        style={{ display: 'none' }}
        onChange={handleChange}
      />

      {/* Preview or placeholder */}
      <div
        onClick={() => !loading && inputRef.current?.click()}
        style={{
          width: '100%', aspectRatio: capture === 'environment' ? '3/2' : '3/4',
          maxHeight: 320,
          borderRadius: 16,
          border: preview ? '2px solid var(--accent)' : '2px dashed var(--border)',
          background: preview ? 'transparent' : 'var(--surface2)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          cursor: loading ? 'default' : 'pointer',
          overflow: 'hidden', position: 'relative',
          transition: 'border-color .2s',
        }}
      >
        {preview ? (
          <img src={preview} alt="captured" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <>
            <div style={{ fontSize: '2.5rem', marginBottom: '.5rem' }}>
              {capture === 'environment' ? '📄' : '🤳'}
            </div>
            <div style={{ fontSize: '.82rem', color: 'var(--muted)', textAlign: 'center', padding: '0 1rem' }}>
              {hint}
            </div>
          </>
        )}
      </div>

      <button
        className="btn btn-primary"
        onClick={() => inputRef.current?.click()}
        disabled={loading}
      >
        {preview ? `Retake ${label}` : `Take ${label}`}
      </button>
    </div>
  );
}

// ── Main wizard ────────────────────────────────────────────────────────────
export function KycWizard({ onComplete, onError }: KycWizardProps) {
  const [step,       setStep]      = useState<Step>('intro');
  const [docType,    setDocType]   = useState<DocType | null>(null);
  const [docFront,   setDocFront]  = useState<string | null>(null);
  const [docBack,    setDocBack]   = useState<string | null>(null);
  const [selfie,     setSelfie]    = useState<string | null>(null);
  const [sessionId,  setSessionId] = useState('');
  const [sessionTok, setSessionTok]= useState('');
  const [error,      setError]     = useState('');
  const [uploading,  setUploading] = useState(false);
  const [uploadMsg,  setUploadMsg] = useState('');

  const needsBack = docType === 'NATIONAL_ID' || docType === 'DRIVERS_LICENSE';

  // ── Start session ──────────────────────────────────────────────────────
  async function startSession() {
    setStep('doc_type');
    if (sessionId) return; // already started
    try {
      const { data } = await api.post('/me/kyc/start');
      setSessionId(data.data.session_id);
      setSessionTok(data.data.session_token);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? 'Failed to start KYC session. Please try again.';
      setError(msg);
      onError?.(msg);
      setStep('error');
    }
  }

  // ── Submit all uploads ─────────────────────────────────────────────────
  async function submit() {
    if (!docFront || !selfie || !sessionId || !sessionTok) return;
    setStep('uploading');
    setUploading(true);

    try {
      setUploadMsg('Uploading document front…');
      await api.post('/me/kyc/upload-doc', {
        session_id: sessionId, session_token: sessionTok,
        document_type: docType, side: 'FRONT', image: docFront,
      });

      if (needsBack && docBack) {
        setUploadMsg('Uploading document back…');
        await api.post('/me/kyc/upload-doc', {
          session_id: sessionId, session_token: sessionTok,
          document_type: docType, side: 'BACK', image: docBack,
        });
      }

      setUploadMsg('Uploading selfie…');
      await api.post('/me/kyc/upload-selfie', {
        session_id: sessionId, session_token: sessionTok, image: selfie,
      });

      setStep('submitted');
      // Notify parent — webhook will update status; treat as pending for now
      onComplete('pending');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? 'Upload failed. Please try again.';
      setError(msg);
      onError?.(msg);
      setStep('error');
    } finally {
      setUploading(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  if (step === 'intro') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
      <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>Identity Verification</div>
      <p style={{ color: 'var(--muted)', fontSize: '.88rem', lineHeight: 1.7, margin: 0 }}>
        We need to verify your identity to unlock bank transfers and currency exchange.
        This takes about 3 minutes.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
        {[
          ['📄', 'A passport, national ID, or driver\'s licence'],
          ['🤳', 'A quick selfie to match your face to the ID'],
        ].map(([icon, text]) => (
          <div key={text as string} style={{ display: 'flex', alignItems: 'center', gap: '.7rem', fontSize: '.86rem', color: 'var(--muted)' }}>
            <span style={{ fontSize: '1.2rem', flexShrink: 0 }}>{icon}</span>
            <span>{text}</span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: '.76rem', color: 'var(--muted)', margin: 0 }}>
        Your data is encrypted and handled in compliance with NDPR / FINTRAC.
      </p>
      <button className="btn btn-primary" style={{ marginTop: '.2rem' }} onClick={startSession}>
        Get Started
      </button>
    </div>
  );

  if (step === 'doc_type') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
      <ProgressBar step={step} docType={docType} />
      <div style={{ fontWeight: 700, fontSize: '1rem' }}>Choose your ID type</div>
      {(['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENSE'] as DocType[]).map(type => (
        <button
          key={type}
          className="btn"
          style={{
            justifyContent: 'flex-start', padding: '1rem 1.2rem',
            borderRadius: 14, fontSize: '.9rem', fontWeight: 600,
            background: docType === type ? 'rgba(139,92,246,0.15)' : 'var(--surface)',
            borderColor: docType === type ? 'var(--accent)' : 'var(--border)',
            color: 'var(--text)',
          }}
          onClick={() => setDocType(type)}
        >
          {DOC_LABELS[type]}
        </button>
      ))}
      <button
        className="btn btn-primary"
        disabled={!docType}
        onClick={() => setStep('doc_front')}
      >
        Continue
      </button>
    </div>
  );

  if (step === 'doc_front') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
      <ProgressBar step={step} docType={docType} />
      <div style={{ fontWeight: 700, fontSize: '1rem' }}>
        {docType === 'PASSPORT' ? 'Photo your passport' : 'Photo the front of your ID'}
      </div>
      <p style={{ fontSize: '.82rem', color: 'var(--muted)', margin: 0 }}>
        Make sure all text is clearly visible and there's no glare or shadows.
      </p>
      <CaptureButton
        label={docType === 'PASSPORT' ? 'Passport' : 'ID Front'}
        hint="Tap to open camera — use your back camera for best results"
        capture="environment"
        preview={docFront}
        loading={false}
        onCapture={setDocFront}
      />
      <button
        className="btn btn-primary"
        disabled={!docFront}
        onClick={() => setStep(needsBack ? 'doc_back' : 'selfie')}
      >
        Continue
      </button>
      <button className="btn btn-ghost" onClick={() => setStep('doc_type')}>← Back</button>
    </div>
  );

  if (step === 'doc_back') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
      <ProgressBar step={step} docType={docType} />
      <div style={{ fontWeight: 700, fontSize: '1rem' }}>Photo the back of your ID</div>
      <p style={{ fontSize: '.82rem', color: 'var(--muted)', margin: 0 }}>
        Flip your ID over and take a clear photo of the back.
      </p>
      <CaptureButton
        label="ID Back"
        hint="Tap to open camera — flip your ID over"
        capture="environment"
        preview={docBack}
        loading={false}
        onCapture={setDocBack}
      />
      <button
        className="btn btn-primary"
        disabled={!docBack}
        onClick={() => setStep('selfie')}
      >
        Continue
      </button>
      <button className="btn btn-ghost" onClick={() => setStep('doc_front')}>← Back</button>
    </div>
  );

  if (step === 'selfie') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
      <ProgressBar step={step} docType={docType} />
      <div style={{ fontWeight: 700, fontSize: '1rem' }}>Take a selfie</div>
      <p style={{ fontSize: '.82rem', color: 'var(--muted)', margin: 0 }}>
        Look straight at the camera in good lighting. Remove sunglasses.
        Your face should match the ID you just photographed.
      </p>
      <CaptureButton
        label="Selfie"
        hint="Tap to open front camera — look straight ahead"
        capture="user"
        preview={selfie}
        loading={false}
        onCapture={setSelfie}
      />
      <button
        className="btn btn-primary"
        disabled={!selfie || uploading}
        onClick={submit}
      >
        Submit Verification
      </button>
      <button className="btn btn-ghost" onClick={() => setStep(needsBack ? 'doc_back' : 'doc_front')}>← Back</button>
    </div>
  );

  if (step === 'uploading') return (
    <div style={{ textAlign: 'center', padding: '2rem 0', display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center' }}>
      <span className="spinner spinner-lg" />
      <div style={{ fontWeight: 600 }}>Submitting…</div>
      <div style={{ fontSize: '.84rem', color: 'var(--muted)' }}>{uploadMsg}</div>
    </div>
  );

  if (step === 'submitted') return (
    <div style={{ textAlign: 'center', padding: '1.5rem 0', display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center' }}>
      <div style={{ fontSize: '3rem' }}>✅</div>
      <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>Submitted!</div>
      <p style={{ fontSize: '.84rem', color: 'var(--muted)', maxWidth: 280, margin: 0 }}>
        Your documents are being reviewed. We'll notify you by email — usually within a few hours.
      </p>
    </div>
  );

  if (step === 'error') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ color: 'var(--danger, #f43f5e)', fontWeight: 600 }}>Something went wrong</div>
      <p style={{ fontSize: '.86rem', color: 'var(--muted)', margin: 0 }}>{error}</p>
      <button className="btn btn-primary" onClick={() => { setStep('intro'); setError(''); }}>Try Again</button>
    </div>
  );

  return null;
}
