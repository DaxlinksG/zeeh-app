/**
 * KycWizard — secure, standalone, exportable KYC flow.
 *
 * Security model:
 *   • User enters their ID number + types their own name.
 *   • Backend looks up the ID and compares the typed name SILENTLY.
 *   • Frontend receives ONLY boolean pass/fail — never sees any third-party data.
 *   • This prevents data exposure AND impersonation via name-change.
 *
 * Steps: intro → id_input → id_verified → passport → liveness → review → done
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../lib/api';
import { toast } from './Toast';

// ─── Types ──────────────────────────────────────────────────────────
export interface KycWizardProps {
  user: { first_name: string; last_name: string; email: string };
  onComplete: (status: 'approved' | 'pending') => void;
  onError?: (msg: string) => void;
}

type Step = 'intro' | 'id_input' | 'id_verified' | 'passport' | 'liveness' | 'review' | 'submitting' | 'done';

interface IdResult {
  idType:    'bvn' | 'nin';
  idNumber:  string;
  nameMatch: boolean;
}

const LIVENESS_POSES = [
  { label: 'Look straight ahead',    icon: '😐', ms: 3000 },
  { label: 'Slowly turn RIGHT →',    icon: '➡️', ms: 3000 },
  { label: 'Back to centre',         icon: '😐', ms: 2000 },
  { label: '← Slowly turn LEFT',     icon: '⬅️', ms: 3000 },
  { label: 'Look straight — hold',   icon: '😐', ms: 2000 },
];

// ─── Camera hook ────────────────────────────────────────────────────
function useCamera(facing: 'user' | 'environment') {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready,  setReady]  = useState(false);
  const [camErr, setCamErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setReady(false); setCamErr(null);
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } },
        });
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play().catch(() => {});
            if (active) setReady(true);
          };
        }
      } catch {
        if (active) setCamErr('Camera permission denied. Allow camera access in settings and try again.');
      }
    })();
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [facing]);

  const capture = useCallback((quality = 0.55): string | null => {
    const v = videoRef.current;
    if (!v || !ready) return null;
    const c = document.createElement('canvas');
    c.width = Math.min(v.videoWidth, 640); c.height = Math.min(v.videoHeight, 480);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }, [ready]);

  return { videoRef, ready, camErr, capture };
}

// ─── Progress bar ────────────────────────────────────────────────────
const STEP_ORDER: Step[] = ['intro', 'id_input', 'id_verified', 'passport', 'liveness', 'review'];
function ProgressBar({ step }: { step: Step }) {
  const idx = STEP_ORDER.indexOf(step);
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: '1.5rem' }}>
      {STEP_ORDER.map((_, i) => (
        <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= idx ? 'var(--accent)' : 'var(--border)', transition: 'background .3s' }} />
      ))}
    </div>
  );
}

// ─── Step: Intro ─────────────────────────────────────────────────────
function IntroStep({ onNext }: { onNext: () => void }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '3.5rem', marginBottom: '1rem' }}>🪪</div>
      <h2 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '.5rem' }}>Identity Verification</h2>
      <p style={{ color: 'var(--muted)', fontSize: '.88rem', marginBottom: '2rem', lineHeight: 1.6 }}>
        To protect all users and comply with regulations, we verify your identity. This takes about 3 minutes.
      </p>
      <div style={{ textAlign: 'left', marginBottom: '2rem' }}>
        {[
          ['🔢', 'Your BVN or NIN (11 digits)'],
          ['📄', 'A physical ID/passport to photograph'],
          ['📸', 'Front-facing camera for a liveness check'],
        ].map(([icon, text]) => (
          <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '.7rem 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: '1.3rem', width: 32, textAlign: 'center' }}>{icon}</span>
            <span style={{ fontSize: '.88rem' }}>{text}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: '.8rem 1rem', background: 'rgba(139,92,246,.08)', borderRadius: 10, fontSize: '.8rem', color: 'var(--muted)', marginBottom: '1.5rem', textAlign: 'left' }}>
        🔒 Your data is verified in real-time and we store only the result — never the raw contents of your ID.
      </div>
      <button className="btn btn-primary btn-full" onClick={onNext}>Start Verification →</button>
    </div>
  );
}

// ─── Step: ID Input ───────────────────────────────────────────────────
// User enters their ID number AND types their own name.
// Backend compares the typed name against the ID record SILENTLY.
// We never return third-party data to the frontend.
function IdInputStep({ onResult }: { onResult: (r: IdResult) => void }) {
  const [idType,   setIdType]   = useState<'bvn' | 'nin'>('bvn');
  const [idNumber, setIdNumber] = useState('');
  const [fullName, setFullName] = useState('');
  const [loading,  setLoading]  = useState(false);

  async function handleVerify() {
    if (!/^\d{11}$/.test(idNumber)) { toast(`${idType.toUpperCase()} must be 11 digits`, 'err'); return; }
    if (fullName.trim().split(' ').filter(Boolean).length < 2) {
      toast('Please enter your full name (first and last)', 'err'); return;
    }
    setLoading(true);
    try {
      const { data } = await api.post('/me/kyc/verify-id', {
        id_type: idType, id_number: idNumber, full_name: fullName.trim(),
      });
      onResult({ idType, idNumber, nameMatch: data.data.nameMatch });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Verification failed. Check the number and try again.';
      toast(msg, 'err');
    } finally { setLoading(false); }
  }

  return (
    <div>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '.4rem' }}>ID Verification</h2>
      <p style={{ color: 'var(--muted)', fontSize: '.84rem', marginBottom: '1.5rem' }}>
        We check your ID against official government records.
      </p>

      {/* ID type toggle */}
      <div style={{ display: 'flex', gap: '.3rem', background: 'var(--surface)', borderRadius: 12, padding: '.3rem', marginBottom: '1.4rem' }}>
        {(['bvn', 'nin'] as const).map(t => (
          <button key={t} onClick={() => setIdType(t)} className="btn" style={{
            flex: 1, padding: '.55rem', fontSize: '.88rem',
            background: idType === t ? 'var(--surface2)' : 'transparent',
            color: idType === t ? 'var(--text)' : 'var(--muted)',
            border: idType === t ? '1px solid var(--border)' : 'none', borderRadius: 9,
          }}>
            {t === 'bvn' ? 'BVN' : 'NIN'}
          </button>
        ))}
      </div>

      <div className="form-group">
        <label>{idType === 'bvn' ? 'Bank Verification Number (BVN)' : 'National Identification Number (NIN)'}</label>
        <input
          type="tel" maxLength={11} inputMode="numeric" autoFocus
          value={idNumber} onChange={e => setIdNumber(e.target.value.replace(/\D/g, ''))}
          placeholder="Enter 11-digit number"
        />
        <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginTop: '.3rem' }}>
          {idType === 'bvn' ? 'Dial *565*0# to get your BVN' : 'Dial *346# to get your NIN'}
        </div>
      </div>

      <div className="form-group">
        <label>Your Full Legal Name (as it appears on your ID)</label>
        <input
          type="text"
          value={fullName} onChange={e => setFullName(e.target.value)}
          placeholder="e.g. David Adeleke"
        />
        <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginTop: '.3rem' }}>
          Type exactly as shown on your ID — this will be checked against the official record
        </div>
      </div>

      <button
        className="btn btn-primary btn-full"
        disabled={loading || idNumber.length !== 11 || fullName.trim().split(' ').filter(Boolean).length < 2}
        onClick={handleVerify}
      >
        {loading ? <span className="spinner" /> : 'Verify Identity →'}
      </button>
    </div>
  );
}

// ─── Step: ID Verified result ─────────────────────────────────────────
// Shows ONLY pass/fail — zero raw data from the API is ever displayed.
function IdVerifiedStep({ result, onNext, onRetry }: { result: IdResult; onNext: () => void; onRetry: () => void }) {
  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '.5rem' }}>{result.nameMatch ? '✅' : '⚠️'}</div>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 700 }}>
          {result.nameMatch ? 'Identity Confirmed' : 'Name Mismatch'}
        </h2>
        <p style={{ color: 'var(--muted)', fontSize: '.84rem', marginTop: '.4rem' }}>
          {result.nameMatch
            ? `Your ${result.idType.toUpperCase()} was verified and your name matches the official record.`
            : `The name you entered does not match the ${result.idType.toUpperCase()} record. Please check and try again.`}
        </p>
      </div>

      <div style={{ padding: '.8rem 1rem', background: result.nameMatch ? 'rgba(16,217,178,.08)' : 'rgba(245,158,11,.08)', border: `1px solid ${result.nameMatch ? 'rgba(16,217,178,.25)' : 'rgba(245,158,11,.25)'}`, borderRadius: 10, fontSize: '.82rem', marginBottom: '1.5rem', color: 'var(--muted)' }}>
        {result.nameMatch
          ? '✅ Name match confirmed against official government records'
          : '⚠️ Mismatch detected. Your submission will require manual review by our compliance team.'}
      </div>

      <div style={{ display: 'flex', gap: '.7rem' }}>
        <button className="btn btn-ghost" onClick={onRetry} style={{ flex: 1 }}>← Try Again</button>
        <button className="btn btn-primary" onClick={onNext} style={{ flex: 2 }}>
          Continue → Document Photo
        </button>
      </div>
    </div>
  );
}

// ─── Step: Passport / Document ────────────────────────────────────────
function PassportStep({ onCapture }: { onCapture: (img: string) => void }) {
  const { videoRef, ready, camErr, capture } = useCamera('environment');
  const [preview,   setPreview]   = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '.3rem' }}>Document Photo</h2>

      {/* Important instruction */}
      <div style={{ padding: '.7rem 1rem', background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.25)', borderRadius: 10, fontSize: '.82rem', color: 'var(--warn)', marginBottom: '1rem', fontWeight: 600 }}>
        ⚠️ You MUST photograph an actual government-issued ID or passport — not a selfie or screen capture. Submitting a selfie here will result in automatic rejection.
      </div>

      <p style={{ color: 'var(--muted)', fontSize: '.84rem', marginBottom: '1rem' }}>
        Hold your ID flat, ensure all text is readable, and stay in good lighting.
      </p>

      {camErr ? (
        <div style={{ padding: '1rem', background: 'rgba(244,63,94,.1)', border: '1px solid rgba(244,63,94,.25)', borderRadius: 10, color: 'var(--danger)', fontSize: '.84rem' }}>{camErr}</div>
      ) : !preview ? (
        <>
          <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', background: '#000', aspectRatio: '4/3', marginBottom: '1rem' }}>
            <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            {ready && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: '88%', aspectRatio: '1.58', border: '2px solid rgba(139,92,246,.9)', borderRadius: 8, boxShadow: '0 0 0 2000px rgba(0,0,0,.45)' }}>
                  <div style={{ position: 'absolute', bottom: '38%', left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,.7)', fontSize: '.72rem', fontWeight: 600, textAlign: 'center', whiteSpace: 'nowrap' }}>
                    Place ID/passport inside frame
                  </div>
                </div>
              </div>
            )}
            {!ready && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}><span className="spinner spinner-lg" /></div>}
          </div>
          <button className="btn btn-primary btn-full" disabled={!ready} onClick={() => setPreview(capture(0.65)!)}>
            📷 Capture Document
          </button>
        </>
      ) : (
        <>
          <div style={{ borderRadius: 16, overflow: 'hidden', marginBottom: '1rem' }}>
            <img src={preview} alt="Document" style={{ width: '100%', display: 'block' }} />
          </div>

          {/* Must confirm it's an ID before continuing */}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '.7rem', padding: '.8rem', background: 'var(--surface2)', borderRadius: 10, marginBottom: '1rem', cursor: 'pointer', textTransform: 'none', letterSpacing: 'normal', fontSize: '.84rem', fontWeight: 400, color: 'var(--text)' }}>
            <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} style={{ width: 18, height: 18, flexShrink: 0, marginTop: 1 }} />
            I confirm this is a photo of a genuine government-issued ID or passport — not a selfie or screen image.
          </label>

          <div style={{ display: 'flex', gap: '.7rem' }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => { setPreview(null); setConfirmed(false); }}>↺ Retake</button>
            <button className="btn btn-success" style={{ flex: 2 }} disabled={!confirmed} onClick={() => onCapture(preview!)}>
              Confirmed ✓
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Step: Liveness ───────────────────────────────────────────────────
function LivenessStep({ onDone }: { onDone: () => void }) {
  const { videoRef, ready, camErr, capture } = useCamera('user');
  const [poseIdx,   setPoseIdx]   = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [completed, setCompleted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capturedRef = useRef<string[]>([]);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  function startPose() {
    if (poseIdx >= LIVENESS_POSES.length) return;
    const pose = LIVENESS_POSES[poseIdx];
    let remaining = Math.round(pose.ms / 1000);
    setCountdown(remaining);
    timerRef.current = setInterval(() => {
      remaining -= 1;
      setCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timerRef.current!);
        const img = capture(0.3);
        if (img) capturedRef.current.push(img);
        setCountdown(null);
        const next = poseIdx + 1;
        if (next >= LIVENESS_POSES.length) { setCompleted(true); onDone(); }
        else setPoseIdx(next);
      }
    }, 1000);
  }

  const pose = LIVENESS_POSES[Math.min(poseIdx, LIVENESS_POSES.length - 1)];

  return (
    <div>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '.3rem' }}>Face Liveness Check</h2>
      <p style={{ color: 'var(--muted)', fontSize: '.84rem', marginBottom: '1rem' }}>
        Follow the instructions. Keep your face well-lit and centred in the oval.
      </p>

      {camErr ? (
        <div style={{ padding: '1rem', background: 'rgba(244,63,94,.1)', border: '1px solid rgba(244,63,94,.25)', borderRadius: 10, color: 'var(--danger)', fontSize: '.84rem' }}>{camErr}</div>
      ) : completed ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '.8rem' }}>✅</div>
          <div style={{ fontWeight: 700 }}>Liveness check complete</div>
        </div>
      ) : (
        <>
          {/* Instruction bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '.8rem 1rem', background: 'var(--surface2)', borderRadius: 12, marginBottom: '.8rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.7rem' }}>
              <span style={{ fontSize: '1.4rem' }}>{pose.icon}</span>
              <span style={{ fontWeight: 700, fontSize: '.9rem' }}>{pose.label}</span>
            </div>
            {countdown !== null && (
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--g-primary)', display: 'grid', placeItems: 'center', fontWeight: 700, color: '#fff' }}>
                {countdown}
              </div>
            )}
          </div>

          {/* Progress dots */}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: '.8rem' }}>
            {LIVENESS_POSES.map((_, i) => (
              <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: i < poseIdx ? 'var(--accent2)' : i === poseIdx ? 'var(--accent)' : 'var(--border)', transition: 'background .3s' }} />
            ))}
          </div>

          {/* Camera with face oval */}
          <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', background: '#000', aspectRatio: '3/4', marginBottom: '1rem' }}>
            <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
            {ready && (
              <svg viewBox="0 0 100 133" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} preserveAspectRatio="none">
                <defs><mask id="oval"><rect width="100" height="133" fill="white" /><ellipse cx="50" cy="60" rx="33" ry="42" fill="black" /></mask></defs>
                <rect width="100" height="133" fill="rgba(0,0,0,0.5)" mask="url(#oval)" />
                <ellipse cx="50" cy="60" rx="33" ry="42" fill="none" stroke={countdown !== null ? '#a78bfa' : 'rgba(139,92,246,.4)'} strokeWidth="0.8" />
              </svg>
            )}
            {!ready && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}><span className="spinner spinner-lg" /></div>}
          </div>

          <button className="btn btn-primary btn-full" disabled={!ready || countdown !== null} onClick={startPose}>
            {countdown !== null ? `Hold — ${countdown}s` : poseIdx === 0 ? '▶ Start Liveness Check' : `Next pose →`}
          </button>
        </>
      )}
    </div>
  );
}

// ─── Step: Review ─────────────────────────────────────────────────────
function ReviewStep({ idResult, onSubmit, loading }: { idResult: IdResult; onSubmit: () => void; loading: boolean }) {
  return (
    <div>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '.4rem' }}>Review & Submit</h2>
      <p style={{ color: 'var(--muted)', fontSize: '.84rem', marginBottom: '1.5rem' }}>All steps complete. Submit for verification.</p>

      <div style={{ background: 'var(--surface2)', borderRadius: 12, padding: '1rem', marginBottom: '1.5rem' }}>
        {[
          ['ID Type',          idResult.idType.toUpperCase()],
          ['Name Verification', idResult.nameMatch ? '✅ Matched' : '⚠️ Mismatch — manual review'],
          ['Document Photo',   '✅ Captured'],
          ['Liveness Check',   '✅ Complete'],
        ].map(([label, value]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '.45rem 0', borderBottom: '1px solid var(--border)', fontSize: '.85rem' }}>
            <span style={{ color: 'var(--muted)' }}>{label}</span>
            <span style={{ fontWeight: 600 }}>{value}</span>
          </div>
        ))}
      </div>

      <div style={{ padding: '.8rem 1rem', background: 'rgba(16,217,178,.07)', border: '1px solid rgba(16,217,178,.2)', borderRadius: 10, fontSize: '.8rem', color: 'var(--muted)', marginBottom: '1.5rem' }}>
        🔒 By submitting you confirm that all details are accurate and the documents are genuine. False submissions may result in account suspension.
      </div>

      <button className="btn btn-success btn-full" disabled={loading} onClick={onSubmit}>
        {loading ? <span className="spinner" /> : 'Submit for Verification ✓'}
      </button>
    </div>
  );
}

// ─── Main KycWizard ──────────────────────────────────────────────────
export function KycWizard({ onComplete, onError }: KycWizardProps) {
  const [step,        setStep]        = useState<Step>('intro');
  const [idResult,    setIdResult]    = useState<IdResult | null>(null);
  const [passportDone, setPassportDone] = useState(false);
  const [livenessDone, setLivenessDone] = useState(false);
  const [submitting,  setSubmitting]  = useState(false);

  async function handleSubmit() {
    if (!idResult) return;
    setSubmitting(true);
    setStep('submitting');
    try {
      const { data } = await api.post('/me/kyc/submit', {
        id_type:        idResult.idType,
        id_number:      idResult.idNumber,
        name_match:     idResult.nameMatch,
        passport_done:  passportDone,
        liveness_done:  livenessDone,
      });
      setStep('done');
      onComplete(data.data?.kyc_status ?? 'pending');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Submission failed. Please try again.';
      toast(msg, 'err');
      onError?.(msg);
      setStep('review');
    } finally { setSubmitting(false); }
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      {!['done', 'submitting'].includes(step) && <ProgressBar step={step} />}

      {step === 'intro'        && <IntroStep onNext={() => setStep('id_input')} />}
      {step === 'id_input'     && <IdInputStep onResult={r => { setIdResult(r); setStep('id_verified'); }} />}
      {step === 'id_verified'  && idResult && (
        <IdVerifiedStep result={idResult} onNext={() => setStep('passport')} onRetry={() => { setIdResult(null); setStep('id_input'); }} />
      )}
      {step === 'passport'     && (
        <PassportStep onCapture={() => { setPassportDone(true); setStep('liveness'); }} />
      )}
      {step === 'liveness'     && (
        <LivenessStep onDone={() => { setLivenessDone(true); setStep('review'); }} />
      )}
      {step === 'review'       && idResult && (
        <ReviewStep idResult={idResult} onSubmit={handleSubmit} loading={submitting} />
      )}
      {step === 'submitting'   && (
        <div style={{ textAlign: 'center', padding: '4rem 2rem' }}>
          <span className="spinner spinner-lg" style={{ display: 'block', margin: '0 auto 1.5rem' }} />
          <div style={{ fontWeight: 600, marginBottom: '.4rem' }}>Submitting verification…</div>
          <div style={{ color: 'var(--muted)', fontSize: '.84rem' }}>This may take a few seconds</div>
        </div>
      )}
      {step === 'done'         && (
        <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🎉</div>
          <h2 style={{ fontWeight: 700, marginBottom: '.5rem' }}>Verification Submitted!</h2>
          <p style={{ color: 'var(--muted)', fontSize: '.9rem', lineHeight: 1.6 }}>
            Our compliance team will review your submission. You'll be notified — usually within a few hours.
          </p>
        </div>
      )}
    </div>
  );
}
