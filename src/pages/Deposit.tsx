import { useEffect, useState } from 'react';
import api from '../lib/api';
import { toast } from '../components/Toast';

interface Instruction { currency: string; [key: string]: unknown; }

const FLAG: Record<string, string> = { CAD: '🇨🇦', USD: '🇺🇸', NGN: '🇳🇬', GBP: '🇬🇧', EUR: '🇪🇺' };

const FIELD_LABELS: Record<string, string> = {
  account_number: 'Account Number',
  account_name:   'Account Name',
  bank_name:      'Bank Name',
  routing_number: 'Routing Number',
  iban:           'IBAN',
  swift:          'SWIFT / BIC',
  sort_code:      'Sort Code',
  send_to_email:  'Interac e-Transfer Email',
  ddt_number:     'DDT Number',
  institution_number: 'Institution #',
  transit_number: 'Transit #',
  wallet_id:      'Wallet ID',
};

function copy(text: string) {
  navigator.clipboard.writeText(String(text));
  toast('Copied!');
}

export default function Deposit() {
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [active,       setActive]       = useState('CAD');

  useEffect(() => {
    api.get('/me/deposit')
      .then(r => {
        const inst = r.data.data?.instructions ?? [];
        setInstructions(inst);
        if (inst.length) setActive(inst[0].currency);
      })
      .catch(() => toast('Could not load deposit instructions', 'err'))
      .finally(() => setLoading(false));
  }, []);

  const current = instructions.find(i => i.currency === active);

  return (
    <div style={{ maxWidth: 600 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '.4rem' }}>Deposit Funds</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1.6rem', fontSize: '.9rem' }}>
        Transfer to the account below. Your balance is credited once confirmed.
      </p>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem' }}><span className="spinner spinner-lg" /></div>
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
                  color: active === i.currency ? '#fff' : 'var(--muted)',
                  border: `1px solid ${active === i.currency ? 'var(--accent)' : 'var(--border)'}`,
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
                  <div style={{ fontSize: '.8rem', color: 'var(--muted)' }}>Use the details below</div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
                {Object.entries(current)
                  .filter(([k]) => k !== 'currency' && FIELD_LABELS[k])
                  .map(([key, val]) => (
                    <div
                      key={key}
                      onClick={() => copy(String(val))}
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
                        <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginBottom: '.1rem' }}>
                          {FIELD_LABELS[key] ?? key}
                        </div>
                        <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{String(val)}</div>
                      </div>
                      <span style={{ color: 'var(--accent2)', fontSize: '.75rem' }}>Copy</span>
                    </div>
                  ))}
              </div>

              <div style={{ marginTop: '1.2rem', padding: '.8rem', background: 'rgba(108,99,255,.06)', borderRadius: 8, fontSize: '.82rem', color: 'var(--muted)' }}>
                💡 Use your <strong style={{ color: 'var(--text)' }}>email address</strong> as the payment reference so we can identify your deposit.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
