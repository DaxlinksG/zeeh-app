import { useEffect, useState } from 'react';
import api from '../lib/api';
import { toast } from '../components/Toast';

interface Instruction {
  currency:       string;
  bank_name?:     string;
  account_name?:  string;
  account_number?: string;
  iban?:          string;
  swift?:         string;
  sort_code?:     string;
  send_to_email?: string;
  wallet_id?:     string;
}

const FLAG: Record<string, string> = { CAD: '🇨🇦', USD: '🇺🇸', NGN: '🇳🇬', GBP: '🇬🇧', EUR: '🇪🇺' };

const FIELD_LABELS: Record<string, string> = {
  bank_name:      'Bank Name',
  account_name:   'Account Name',
  account_number: 'Account Number',
  send_to_email:  'Interac e-Transfer Email',
  iban:           'IBAN',
  swift:          'SWIFT / BIC',
  sort_code:      'Sort Code',
  wallet_id:      'Wallet Reference',
};

function copyToClipboard(text: string) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  toast('Copied!');
}

export default function Deposit() {
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(false);
  const [active,       setActive]       = useState('');

  useEffect(() => {
    api.get('/me/deposit')
      .then(r => {
        const inst: Instruction[] = r.data.data?.instructions ?? [];
        setInstructions(inst);
        if (inst.length > 0) setActive(inst[0].currency);
      })
      .catch(() => {
        setError(true);
        toast('Could not load deposit instructions', 'err');
      })
      .finally(() => setLoading(false));
  }, []);

  const current = instructions.find(i => i.currency === active);

  // Which fields to show for this currency (non-empty values only)
  const fields: [string, string][] = current
    ? (Object.entries(FIELD_LABELS) as [string, string][])
        .map(([key, label]) => {
          const val = (current as Record<string, unknown>)[key];
          return val ? [label, String(val)] : null;
        })
        .filter((x): x is [string, string] => x !== null)
    : [];

  return (
    <div style={{ maxWidth: 600 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '.4rem' }}>Deposit Funds</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1.6rem', fontSize: '.9rem' }}>
        Transfer to the account below. Your balance is credited once confirmed by our team.
      </p>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem' }}><span className="spinner spinner-lg" /></div>
      ) : error ? (
        <div className="card" style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '.6rem' }}>⚠️</div>
          <div>Could not load deposit instructions.</div>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: '1rem' }} onClick={() => window.location.reload()}>
            Try Again
          </button>
        </div>
      ) : instructions.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>
          No deposit instructions available right now.
        </div>
      ) : (
        <>
          {/* Currency tabs */}
          <div style={{ display: 'flex', gap: '.4rem', marginBottom: '1.4rem', flexWrap: 'wrap' }}>
            {instructions.map(i => (
              <button
                key={i.currency}
                onClick={() => setActive(i.currency)}
                className="btn btn-sm"
                style={{
                  background: active === i.currency ? 'var(--accent)' : 'var(--surface)',
                  color:      active === i.currency ? '#fff'           : 'var(--muted)',
                  border:     `1px solid ${active === i.currency ? 'var(--accent)' : 'var(--border)'}`,
                }}
              >
                {FLAG[i.currency] ?? '🌐'} {i.currency}
              </button>
            ))}
          </div>

          {current && (
            <div className="card">
              <div style={{ marginBottom: '1.2rem', display: 'flex', alignItems: 'center', gap: '.6rem' }}>
                <span style={{ fontSize: '1.6rem' }}>{FLAG[current.currency] ?? '🌐'}</span>
                <div>
                  <div style={{ fontWeight: 600 }}>{current.currency} Deposit</div>
                  <div style={{ fontSize: '.8rem', color: 'var(--muted)' }}>
                    {current.bank_name ?? 'Bank Transfer'}
                  </div>
                </div>
              </div>

              {fields.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
                  {fields.map(([label, val]) => (
                    <div
                      key={label}
                      onClick={() => copyToClipboard(val)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '.75rem 1rem', background: 'var(--bg)', borderRadius: 8,
                        border: '1px solid var(--border)', cursor: 'pointer',
                        transition: 'border-color .15s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                    >
                      <div>
                        <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginBottom: '.1rem' }}>{label}</div>
                        <div style={{ fontFamily: 'monospace', fontWeight: 600, wordBreak: 'break-all' }}>{val}</div>
                      </div>
                      <span style={{ color: 'var(--accent2)', fontSize: '.75rem', flexShrink: 0, marginLeft: '.5rem' }}>Copy</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: 'var(--muted)', fontSize: '.85rem' }}>
                  Contact support for {current.currency} deposit instructions.
                </div>
              )}

              <div style={{ marginTop: '1.2rem', padding: '.8rem', background: 'rgba(108,99,255,.06)', borderRadius: 8, fontSize: '.82rem', color: 'var(--muted)' }}>
                💡 Use your <strong style={{ color: 'var(--text)' }}>registered email address</strong> as the payment reference so we can match your deposit.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
