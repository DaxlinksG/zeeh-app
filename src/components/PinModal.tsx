import { useState, useEffect } from 'react';

interface Props {
  title?:     string;
  onConfirm:  (pin: string) => void;
  onCancel:   () => void;
  loading?:   boolean;
  error?:     string;
}

export function PinModal({
  title = 'Transaction PIN',
  onConfirm,
  onCancel,
  loading,
  error,
}: Props) {
  const [pin, setPin] = useState('');

  // Clear PIN whenever an error comes in so the user retypes
  useEffect(() => { if (error) setPin(''); }, [error]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pin.length !== 4 || loading) return;
    onConfirm(pin);
  }

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,.72)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999, padding: '1rem',
    }}>
      <div className="card" style={{ width: '100%', maxWidth: 340 }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '2rem', marginBottom: '.4rem' }}>🔐</div>
          <div style={{ fontWeight: 700, fontSize: '1.05rem', marginBottom: '.3rem' }}>{title}</div>
          <div style={{ fontSize: '.84rem', color: 'var(--muted)' }}>
            Enter your 4-digit transaction PIN to continue
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            maxLength={4}
            value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="••••"
            autoFocus
            style={{
              width: '100%',
              textAlign: 'center',
              fontSize: '2rem',
              letterSpacing: '0.6em',
              fontFamily: 'monospace',
              marginBottom: error ? '.5rem' : '1rem',
              padding: '.7rem',
              background: 'var(--bg)',
              border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
              borderRadius: 'var(--radius)',
              color: 'var(--text)',
            }}
          />

          {error && (
            <div style={{
              color: 'var(--danger)', fontSize: '.82rem',
              textAlign: 'center', marginBottom: '1rem',
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '.6rem' }}>
            <button
              type="button"
              className="btn"
              style={{ flex: 1 }}
              onClick={onCancel}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              style={{ flex: 2 }}
              disabled={loading || pin.length !== 4}
            >
              {loading ? <span className="spinner" /> : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
