/**
 * KycWizard — standalone, exportable KYC flow component.
 *
 * Steps:
 *   intro → id_verify → id_result → passport → liveness → review → done
 *
 * Designed for Nigeria (BVN + NIN) but extensible for other regions.
 * Can be extracted into its own package for B2B embedding.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../lib/api';
import { toast } from './Toast';

// ─── Types ──────────────────────────────────────────────────────────
export interface KycWizardProps {
  user: { first_name: string; last_name: string; email: string; phone?: string };
  onComplete: (status: 'approved' | 'pending') => void;
  onError?: (msg: string) => void;
}

interface IdVerifyData {
  type:        'bvn' | 'nin';
  number:      string;
  name:        string;       // from API
  dob:         string;       // from API
  phone:       string;       // masked
  gender:      string;
  faceImage:   string;       // base64 from BVN/NIN record
  nameMatch:   boolean;
  dobMatch:    boolean;
}

type Step =
  | 'intro'
  | 'id_verify'
  | 'id_result'
  | 'passport'
  | 'liveness'
  | 'review'
  | 'submitting'
  | 'done';

const LIVENESS_POSES = [
  { label: 'Look straight ahead',  icon: '😐', duration: 3 },
  { label: 'Slowly turn RIGHT →',  icon: '➡️', duration: 3 },
  { label: 'Back to centre',       icon: '😐', duration: 2 },
  { label: 'Slowly turn LEFT ←',   icon: '⬅️', duration: 3 },
  { label: 'Look straight — hold', icon: '😐', duration: 2 },
];

// ─── Camera hook ────────────────────────────────────────────────────
function useCamera(facing: 'user' | 'environment') {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const streamRef  = useRef<MediaStream | null>(null);
  const [ready, setReady]   = useState(false);
  const [camErr, setCamErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setReady(false);
    setCamErr(null);

    async function start() {
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
        if (active) setCamErr('Camera access denied. Please allow camera access in your phone settings and try again.');
      }
    }
    start();
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [facing]);

  const capture = useCallback((quality = 0.55): string | null => {
    const v = videoRef.current;
    if (!v || !ready) return null;
    const c = document.createElement('canvas');
    c.width  = Math.min(v.videoWidth,  640);
    c.height = Math.min(v.videoHeight, 480);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }, [ready]);

  return { videoRef, ready, camErr, capture };
}

// ─── Shared UI helpers ───────────────────────────────────────────────
const STEPS_META: { step: Step; label: string }[] = [
  { step: 'intro',     label: 'Intro' },
  { step: 'id_verify', label: 'ID Check' },
  { step: 'passport',  label: 'Document' },
  { step: 'liveness',  label: 'Liveness' },
  { step: 'review',    label: 'Review' },
];

function StepBar({ current }: { current: Step }) {
  const idx = STEPS_META.findIndex(s => s.step === current);
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: '1.5rem' }}>
      {STEPS_META.map((s, i) => (
        <div key={s.step} style={{
          flex: 1, height: 4, borderRadius: 2,
          background: i <= idx ? 'var(--accent)' : 'var(--border)',
          transition: 'background .3s',
        }} />
      ))}
    </div>
  );
}

function MatchBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', padding: '.55rem .9rem', background: ok ? 'rgba(16,217,178,.1)' : 'rgba(244,63,94,.1)', borderRadius: 10, border: `1px solid ${ok ? 'rgba(16,217,178,.25)' : 'rgba(244,63,94,.25)'}` }}>
      <span style={{ fontSize: '1rem' }}>{ok ? '✅' : '❌'}</span>
      <span style={{ fontWeight: 600, fontSize: '.85rem', color: ok ? 'var(--accent2)' : 'var(--danger)' }}>{label}</span>
    </div>
  );
}

// ─── Individual steps ────────────────────────────────────────────────

function IntroStep({ onNext }: { onNext: () => void }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '3.5rem', marginBottom: '1rem' }}>🪪</div>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '.5rem' }}>Identity Verification</h2>
      <p style={{ color: 'var(--muted)', fontSize: '.9rem', marginBottom: '2rem', lineHeight: 1.6 }}>
        To protect our users and comply with regulations, we verify your identity. This takes about 3 minutes.
      </p>

      <div style={{ textAlign: 'left', marginBottom: '2rem' }}>
        {[
          { icon: '🔢', text: 'Your BVN or NIN (11 digits)' },
          { icon: '📄', text: 'International passport or valid ID' },
          { icon: '📸', text: 'Front-facing camera for a selfie' },
        ].map(item => (
          <div key={item.text} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '.7rem 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: '1.3rem', width: 32, textAlign: 'center' }}>{item.icon}</span>
            <span style={{ fontSize: '.9rem' }}>{item.text}</span>
          </div>
        ))}
      </div>

      <div style={{ padding: '.8rem 1rem', background: 'rgba(139,92,246,.08)', borderRadius: 10, fontSize: '.8rem', color: 'var(--muted)', marginBottom: '1.5rem' }}>
        🔒 Your data is encrypted and stored securely. We comply with NDPR and GDPR data protection standards.
      </div>

      <button className="btn btn-primary btn-full" onClick={onNext}>
        Start Verification →
      </button>
    </div>
  );
}

function IdVerifyStep({
  onResult,
}: {
  onResult: (data: IdVerifyData) => void;
  user?: { first_name: string; last_name: string };
}) {
  const [bvn,      setBvn]      = useState('');
  const [nin,      setNin]      = useState('');
  const [loading,  setLoading]  = useState(false);
  const [idType,   setIdType]   = useState<'bvn' | 'nin'>('bvn');

  async function handleVerify() {
    const num = idType === 'bvn' ? bvn.trim() : nin.trim();
    if (!/^\d{11}$/.test(num)) {
      toast(`${idType.toUpperCase()} must be exactly 11 digits`, 'err'); return;
    }
    setLoading(true);
    try {
      const endpoint = idType === 'bvn' ? '/me/kyc/verify-bvn' : '/me/kyc/verify-nin';
      const body = idType === 'bvn' ? { bvn: num } : { nin: num };
      const { data } = await api.post(endpoint, body);

      const d = data.data;
      onResult({
        type:      idType,
        number:    num,
        name:      `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim(),
        dob:       d.dateOfBirth ?? '',
        phone:     d.phone ?? '',
        gender:    d.gender ?? '',
        faceImage: d.faceImage ?? '',
        nameMatch: d.nameMatch ?? false,
        dobMatch:  d.dobMatch ?? false,
      });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message
        ?? 'Verification failed. Check the number and try again.';
      toast(msg, 'err');
    } finally { setLoading(false); }
  }

  return (
    <div>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '.4rem' }}>ID Verification</h2>
      <p style={{ color: 'var(--muted)', fontSize: '.84rem', marginBottom: '1.5rem' }}>
        We'll verify your identity with the government database.
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
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {idType === 'bvn' ? (
        <div className="form-group">
          <label>Bank Verification Number (BVN)</label>
          <input
            type="tel" maxLength={11} inputMode="numeric" autoFocus
            value={bvn} onChange={e => setBvn(e.target.value.replace(/\D/g, ''))}
            placeholder="Enter your 11-digit BVN"
          />
          <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginTop: '.4rem' }}>
            Dial <strong>*565*0#</strong> on any Nigerian network to get your BVN
          </div>
        </div>
      ) : (
        <div className="form-group">
          <label>National Identification Number (NIN)</label>
          <input
            type="tel" maxLength={11} inputMode="numeric" autoFocus
            value={nin} onChange={e => setNin(e.target.value.replace(/\D/g, ''))}
            placeholder="Enter your 11-digit NIN"
          />
          <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginTop: '.4rem' }}>
            Dial <strong>*346#</strong> or check your NIN slip / e-ID card
          </div>
        </div>
      )}

      <button
        className="btn btn-primary btn-full"
        disabled={loading || (idType === 'bvn' ? bvn.length !== 11 : nin.length !== 11)}
        onClick={handleVerify}
        style={{ marginTop: '.5rem' }}
      >
        {loading ? <span className="spinner" /> : `Verify ${idType.toUpperCase()} →`}
      </button>
    </div>
  );
}

function IdResultStep({
  idData,
  onNext,
  onRetry,
}: {
  idData: IdVerifyData;
  onNext: () => void;
  onRetry: () => void;
}) {
  const overallMatch = idData.nameMatch || idData.dobMatch;
  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '.5rem' }}>{overallMatch ? '✅' : '⚠️'}</div>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 700 }}>
          {overallMatch ? 'Identity Verified' : 'Partial Match'}
        </h2>
        <p style={{ color: 'var(--muted)', fontSize: '.84rem', marginTop: '.3rem' }}>
          {idType(idData.type)} details retrieved from official records
        </p>
      </div>

      {/* Verification data card */}
      <div style={{ background: 'var(--surface2)', borderRadius: 12, padding: '1rem 1.2rem', marginBottom: '1.2rem' }}>
        <div style={{ fontWeight: 700, fontSize: '.9rem', marginBottom: '.8rem' }}>
          {idData.name}
        </div>
        {[
          { label: 'Date of Birth', value: idData.dob },
          { label: 'Phone',         value: idData.phone },
          { label: 'Gender',        value: idData.gender },
        ].filter(r => r.value).map(row => (
          <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '.35rem 0', fontSize: '.84rem', borderBottom: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--muted)' }}>{row.label}</span>
            <span style={{ fontWeight: 500 }}>{row.value}</span>
          </div>
        ))}
      </div>

      {/* Match indicators */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', marginBottom: '1.5rem' }}>
        <MatchBadge ok={idData.nameMatch} label={idData.nameMatch ? 'Name matches your profile' : 'Name mismatch — contact support if incorrect'} />
        {idData.dob && <MatchBadge ok={idData.dobMatch} label={idData.dobMatch ? 'Date of birth matches' : 'Date of birth mismatch'} />}
      </div>

      {!overallMatch && (
        <div style={{ padding: '.8rem 1rem', background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.25)', borderRadius: 10, fontSize: '.82rem', marginBottom: '1.2rem', color: 'var(--warn)' }}>
          ⚠️ Some details don't match your profile. Your KYC will be submitted for manual review by our team.
        </div>
      )}

      <div style={{ display: 'flex', gap: '.7rem' }}>
        <button className="btn btn-ghost" onClick={onRetry} style={{ flex: 1 }}>Try Again</button>
        <button className="btn btn-primary" onClick={onNext} style={{ flex: 2 }}>
          Continue → Passport
        </button>
      </div>
    </div>
  );
}

function idType(t: 'bvn' | 'nin') {
  return t === 'bvn' ? 'BVN' : 'NIN';
}

function PassportStep({ onCapture }: { onCapture: (img: string) => void }) {
  const { videoRef, ready, camErr, capture } = useCamera('environment');
  const [preview, setPreview] = useState<string | null>(null);

  function handleCapture() {
    const img = capture(0.65);
    if (img) setPreview(img);
  }

  return (
    <div>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '.3rem' }}>Passport / ID Photo</h2>
      <p style={{ color: 'var(--muted)', fontSize: '.84rem', marginBottom: '1rem' }}>
        Place your passport or ID inside the frame. Ensure good lighting.
      </p>

      {camErr ? (
        <div style={{ padding: '1rem', background: 'rgba(244,63,94,.1)', border: '1px solid rgba(244,63,94,.25)', borderRadius: 10, color: 'var(--danger)', fontSize: '.84rem' }}>
          {camErr}
        </div>
      ) : !preview ? (
        <>
          {/* Camera view */}
          <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', background: '#000', aspectRatio: '4/3', marginBottom: '1rem' }}>
            <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            {/* Document guide overlay */}
            {ready && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{
                  width: '85%', aspectRatio: '1.58',  // passport aspect ratio
                  border: '2px solid rgba(139,92,246,0.8)',
                  borderRadius: 8,
                  boxShadow: '0 0 0 2000px rgba(0,0,0,0.45)',
                }}>
                  <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', color: 'rgba(255,255,255,0.6)', fontSize: '.75rem', fontWeight: 600, textAlign: 'center', pointerEvents: 'none' }}>
                    Position ID here
                  </div>
                </div>
              </div>
            )}
            {!ready && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                <span className="spinner spinner-lg" />
              </div>
            )}
          </div>
          <button className="btn btn-primary btn-full" disabled={!ready} onClick={handleCapture}>
            📷 Capture Photo
          </button>
        </>
      ) : (
        <>
          <div style={{ borderRadius: 16, overflow: 'hidden', marginBottom: '1rem' }}>
            <img src={preview} alt="Passport" style={{ width: '100%', display: 'block' }} />
          </div>
          <div style={{ display: 'flex', gap: '.7rem' }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setPreview(null)}>↺ Retake</button>
            <button className="btn btn-success" style={{ flex: 2 }} onClick={() => onCapture(preview)}>
              Looks Good ✓
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function LivenessStep({ onCapture }: { onCapture: (images: string[]) => void }) {
  const { videoRef, ready, camErr, capture } = useCamera('user');
  const [poseIdx,   setPoseIdx]   = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [captured,  setCaptured]  = useState<string[]>([]);
  const [done,      setDone]      = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPose = useCallback(() => {
    if (poseIdx >= LIVENESS_POSES.length) return;
    const pose = LIVENESS_POSES[poseIdx];
    setCountdown(pose.duration);

    let remaining = pose.duration;
    timerRef.current = setInterval(() => {
      remaining -= 1;
      setCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timerRef.current!);
        const img = capture(0.35); // low quality for liveness frames
        const newCaptured = img ? [...captured, img] : captured;
        setCaptured(newCaptured);
        setCountdown(null);

        const nextIdx = poseIdx + 1;
        if (nextIdx >= LIVENESS_POSES.length) {
          setDone(true);
          onCapture(newCaptured);
        } else {
          setPoseIdx(nextIdx);
        }
      }
    }, 1000);
  }, [poseIdx, capture, captured, onCapture]);

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const pose = LIVENESS_POSES[poseIdx] ?? LIVENESS_POSES[LIVENESS_POSES.length - 1];

  return (
    <div>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '.3rem' }}>Face Verification</h2>
      <p style={{ color: 'var(--muted)', fontSize: '.84rem', marginBottom: '1rem' }}>
        Follow the instructions. Keep your face well-lit and within the oval.
      </p>

      {camErr ? (
        <div style={{ padding: '1rem', background: 'rgba(244,63,94,.1)', border: '1px solid rgba(244,63,94,.25)', borderRadius: 10, color: 'var(--danger)', fontSize: '.84rem' }}>
          {camErr}
        </div>
      ) : done ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '.8rem' }}>✅</div>
          <div style={{ fontWeight: 700 }}>Liveness check complete</div>
        </div>
      ) : (
        <>
          {/* Instruction header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '.8rem 1rem', background: 'var(--surface2)',
            borderRadius: 12, marginBottom: '.8rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.7rem' }}>
              <span style={{ fontSize: '1.4rem' }}>{pose.icon}</span>
              <span style={{ fontWeight: 700, fontSize: '.9rem' }}>{pose.label}</span>
            </div>
            {countdown !== null && (
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                background: 'var(--g-primary)', display: 'grid', placeItems: 'center',
                fontWeight: 700, color: '#fff', fontSize: '1rem',
              }}>
                {countdown}
              </div>
            )}
          </div>

          {/* Progress dots */}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: '.8rem' }}>
            {LIVENESS_POSES.map((_, i) => (
              <div key={i} style={{
                width: 8, height: 8, borderRadius: '50%',
                background: i < poseIdx ? 'var(--accent2)' : i === poseIdx ? 'var(--accent)' : 'var(--border)',
                transition: 'background .3s',
              }} />
            ))}
          </div>

          {/* Camera view with face oval */}
          <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', background: '#000', aspectRatio: '3/4', marginBottom: '1rem' }}>
            <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />

            {/* Face oval overlay using SVG */}
            {ready && (
              <svg viewBox="0 0 100 133" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} preserveAspectRatio="none">
                <defs>
                  <mask id="ovalMask">
                    <rect width="100" height="133" fill="white" />
                    <ellipse cx="50" cy="60" rx="33" ry="42" fill="black" />
                  </mask>
                </defs>
                <rect width="100" height="133" fill="rgba(0,0,0,0.5)" mask="url(#ovalMask)" />
                <ellipse cx="50" cy="60" rx="33" ry="42" fill="none"
                  stroke={countdown !== null ? '#a78bfa' : 'rgba(139,92,246,0.4)'}
                  strokeWidth="0.8"
                  style={{ transition: 'stroke .3s' }}
                />
              </svg>
            )}
            {!ready && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                <span className="spinner spinner-lg" />
              </div>
            )}
          </div>

          <button
            className="btn btn-primary btn-full"
            disabled={!ready || countdown !== null}
            onClick={startPose}
          >
            {countdown !== null
              ? `Hold still — ${countdown}s`
              : poseIdx === 0 ? '▶ Start Check' : `Next: ${LIVENESS_POSES[poseIdx]?.label ?? 'Done'}`
            }
          </button>
        </>
      )}
    </div>
  );
}

function ReviewStep({
  idData,
  onSubmit,
  loading,
}: {
  idData: IdVerifyData;
  onSubmit: () => void;
  loading: boolean;
}) {
  return (
    <div>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '.4rem' }}>Review & Submit</h2>
      <p style={{ color: 'var(--muted)', fontSize: '.84rem', marginBottom: '1.5rem' }}>
        Confirm everything looks correct before submitting.
      </p>

      <div style={{ background: 'var(--surface2)', borderRadius: 12, padding: '1rem', marginBottom: '1.5rem' }}>
        {[
          { label: 'Verified via', value: idType(idData.type) },
          { label: 'Name on record', value: idData.name },
          { label: 'Date of Birth', value: idData.dob },
          { label: 'Name match', value: idData.nameMatch ? '✅ Matched' : '⚠️ Partial' },
          { label: 'Passport photo', value: '✅ Captured' },
          { label: 'Liveness check', value: '✅ Complete' },
        ].map(row => (
          <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '.45rem 0', borderBottom: '1px solid var(--border)', fontSize: '.85rem' }}>
            <span style={{ color: 'var(--muted)' }}>{row.label}</span>
            <span style={{ fontWeight: 600 }}>{row.value}</span>
          </div>
        ))}
      </div>

      <div style={{ padding: '.8rem 1rem', background: 'rgba(16,217,178,.07)', border: '1px solid rgba(16,217,178,.2)', borderRadius: 10, fontSize: '.8rem', color: 'var(--muted)', marginBottom: '1.5rem' }}>
        🔒 By submitting, you confirm that all information is accurate. False information may result in account suspension.
      </div>

      <button className="btn btn-success btn-full" disabled={loading} onClick={onSubmit}>
        {loading ? <span className="spinner" /> : 'Submit for Verification ✓'}
      </button>
    </div>
  );
}

// ─── Main KycWizard ─────────────────────────────────────────────────
export function KycWizard({ user, onComplete, onError }: KycWizardProps) {
  const [step,          setStep]          = useState<Step>('intro');
  const [idData,        setIdData]        = useState<IdVerifyData | null>(null);
  const [passportImg,   setPassportImg]   = useState<string | null>(null);
  const [livenessImgs,  setLivenessImgs]  = useState<string[]>([]);
  const [submitting,    setSubmitting]    = useState(false);

  async function handleSubmit() {
    if (!idData || !passportImg) return;
    setSubmitting(true);
    setStep('submitting');
    try {
      const res = await api.post('/me/kyc/submit', {
        id_type:         idData.type,
        id_number:       idData.number,
        id_name:         idData.name,
        id_dob:          idData.dob,
        name_match:      idData.nameMatch,
        dob_match:       idData.dobMatch,
        face_image:      idData.faceImage,   // from BVN/NIN record
        passport_image:  passportImg,
        liveness_images: livenessImgs,
      });
      const status = res.data.data?.kyc_status ?? 'pending';
      setStep('done');
      onComplete(status);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Submission failed. Please try again.';
      toast(msg, 'err');
      onError?.(msg);
      setStep('review');
    } finally { setSubmitting(false); }
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      {/* Progress bar — hide on done/submitting */}
      {step !== 'done' && step !== 'submitting' && (
        <StepBar current={step} />
      )}

      {step === 'intro' && (
        <IntroStep onNext={() => setStep('id_verify')} />
      )}

      {step === 'id_verify' && (
        <IdVerifyStep
          user={user}
          onResult={data => { setIdData(data); setStep('id_result'); }}
        />
      )}

      {step === 'id_result' && idData && (
        <IdResultStep
          idData={idData}
          onNext={() => setStep('passport')}
          onRetry={() => { setIdData(null); setStep('id_verify'); }}
        />
      )}

      {step === 'passport' && (
        <PassportStep
          onCapture={img => { setPassportImg(img); setStep('liveness'); }}
        />
      )}

      {step === 'liveness' && (
        <LivenessStep
          onCapture={imgs => { setLivenessImgs(imgs); setStep('review'); }}
        />
      )}

      {step === 'review' && idData && (
        <ReviewStep
          idData={idData}
          onSubmit={handleSubmit}
          loading={submitting}
        />
      )}

      {step === 'submitting' && (
        <div style={{ textAlign: 'center', padding: '4rem 2rem' }}>
          <span className="spinner spinner-lg" style={{ marginBottom: '1.5rem', display: 'block', margin: '0 auto 1.5rem' }} />
          <div style={{ fontWeight: 600, marginBottom: '.4rem' }}>Submitting your verification…</div>
          <div style={{ color: 'var(--muted)', fontSize: '.84rem' }}>This may take a few seconds</div>
        </div>
      )}

      {step === 'done' && (
        <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🎉</div>
          <h2 style={{ fontWeight: 700, marginBottom: '.5rem' }}>Verification Submitted!</h2>
          <p style={{ color: 'var(--muted)', fontSize: '.9rem', lineHeight: 1.6 }}>
            Your identity is being reviewed by our compliance team. You'll be notified once approved — usually within a few hours.
          </p>
        </div>
      )}
    </div>
  );
}
