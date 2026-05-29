import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../lib/api';
import { toast } from '../components/Toast';
import { PullToRefresh } from '../components/PullToRefresh';

interface Balance  { currency: string; balance: string; available: string; reserved: string; }
interface Txn {
  txn_id: string; type: string; direction: 'credit' | 'debit';
  currency: string; amount: string; balance_after: string;
  reference: string; description: string; created_at: string;
}
interface DepositInstruction {
  currency: string; bank_name?: string; account_name?: string;
  account_number?: string; iban?: string; swift?: string;
  sort_code?: string; send_to_email?: string; wallet_id?: string;
}

const FLAG:  Record<string, string> = { CAD:'🇨🇦', USD:'🇺🇸', NGN:'🇳🇬', GBP:'🇬🇧', EUR:'🇪🇺' };
const NAME:  Record<string, string> = { CAD:'Canadian Dollar', USD:'US Dollar', NGN:'Nigerian Naira', GBP:'British Pound', EUR:'Euro' };
const FIELD_LABELS: Record<string, string> = {
  bank_name:'Bank Name', account_name:'Account Name', account_number:'Account Number',
  send_to_email:'Interac e-Transfer Email', iban:'IBAN', swift:'SWIFT / BIC',
  sort_code:'Sort Code', wallet_id:'Wallet Reference',
};

const TYPE_LABELS: Record<string, string> = {
  deposit:'Deposit', transfer:'Transfer',
  swap_debit:'Exchange (out)', swap_credit:'Exchange (in)', refund:'Refund', fee:'Fee',
};

function groupByDate(txns: Txn[]): { label: string; txns: Txn[] }[] {
  const map = new Map<string, Txn[]>();
  for (const t of txns) {
    const label = new Date(t.created_at).toLocaleDateString('en-US', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(t);
  }
  return Array.from(map.entries()).map(([label, txns]) => ({ label, txns }));
}

function copyToClipboard(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
  toast('Copied!');
}

export default function CurrencyWallet() {
  const { currency = '' }         = useParams<{ currency: string }>();
  const CUR                        = currency.toUpperCase();
  const navigate                   = useNavigate();
  const [searchParams]             = useSearchParams();
  const initialTab                 = searchParams.get('tab') === 'deposit' ? 'deposit' : 'transactions';

  const [balance,  setBalance]  = useState<Balance | null>(null);
  const [txns,     setTxns]     = useState<Txn[]>([]);
  const [deposit,  setDeposit]  = useState<DepositInstruction | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [tab,      setTab]      = useState<'transactions'|'deposit'>(initialTab);

  const load = useCallback(async () => {
    try {
      const [balRes, txnRes, depRes] = await Promise.all([
        api.get(`/me/balance/${CUR}`),
        api.get('/me/transactions?limit=100'),
        api.get('/me/deposit'),
      ]);
      setBalance(balRes.data.data);
      const all: Txn[] = txnRes.data.data?.transactions ?? [];
      setTxns(all.filter(t => t.currency === CUR));
      const instructions: DepositInstruction[] = depRes.data.data?.instructions ?? [];
      setDeposit(instructions.find(i => i.currency === CUR) ?? null);
    } catch {
      toast('Failed to load wallet data', 'err');
    } finally { setLoading(false); }
  }, [CUR]);

  useEffect(() => { load(); }, [load]);

  const actions = [
    { label: 'Send',     icon: '↗', color: '#7c3aed', onClick: () => navigate('/send') },
    { label: 'Add',      icon: '+', color: '#10b981', onClick: () => setTab('deposit') },
    { label: 'Pay',      icon: '🏦', color: '#0ea5e9', onClick: () => navigate(`/pay?currency=${CUR}`) },
    { label: 'Exchange', icon: '⇄', color: '#f59e0b', onClick: () => navigate(`/exchange?from=${CUR}`) },
  ];

  const groups = groupByDate(txns);

  const depositFields: [string, string][] = deposit
    ? (Object.entries(FIELD_LABELS) as [string, string][])
        .map(([key, label]) => {
          const val = (deposit as unknown as Record<string, unknown>)[key];
          return val ? [label, String(val)] : null;
        })
        .filter((x): x is [string, string] => x !== null)
    : [];

  return (
    <>
      <PullToRefresh onRefresh={load} />

      <div style={{ maxWidth: 560 }}>
        {/* Back */}
        <button
          onClick={() => navigate(-1)}
          className="btn btn-ghost btn-sm"
          style={{ marginBottom: '1rem' }}
        >
          ← Back
        </button>

        {/* Hero balance */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '.4rem' }}>{FLAG[CUR] ?? '🌐'}</div>
          <div style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: '.6rem' }}>
            {NAME[CUR] ?? CUR} balance
          </div>
          {loading ? (
            <div style={{ padding: '1rem' }}><span className="spinner spinner-lg" /></div>
          ) : (
            <>
              <div style={{
                fontSize: '2.8rem', fontWeight: 700, letterSpacing: '-.03em',
                background: 'var(--g-heading)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              }}>
                {parseFloat(balance?.available ?? '0').toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div style={{ fontSize: '1rem', color: 'var(--muted)', marginTop: '.2rem', fontWeight: 600 }}>{CUR}</div>
              {balance && parseFloat(balance.balance) !== parseFloat(balance.available) && (
                <div style={{ fontSize: '.78rem', color: 'var(--warn)', marginTop: '.4rem' }}>
                  {parseFloat(balance.balance).toLocaleString('en-CA', { minimumFractionDigits: 2 })} {CUR} total · some reserved
                </div>
              )}
            </>
          )}
        </div>

        {/* Quick actions */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '.6rem', marginBottom: '2rem' }}>
          {actions.map(a => (
            <button
              key={a.label}
              onClick={a.onClick}
              style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 16, padding: '1rem .5rem',
                cursor: 'pointer', display: 'flex', flexDirection: 'column',
                alignItems: 'center', gap: '.5rem',
                transition: 'all .18s ease',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)'; }}
            >
              <div style={{
                width: 46, height: 46, borderRadius: '50%',
                background: `${a.color}22`,
                border: `2px solid ${a.color}44`,
                display: 'grid', placeItems: 'center',
                fontSize: '1.1rem', color: a.color,
              }}>
                {a.icon}
              </div>
              <span style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text)' }}>{a.label}</span>
            </button>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '.3rem', marginBottom: '1.4rem', background: 'var(--surface)', borderRadius: 12, padding: '.3rem' }}>
          {(['transactions', 'deposit'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className="btn" style={{
              flex: 1, padding: '.55rem', fontSize: '.86rem',
              background: tab === t ? 'var(--surface2)' : 'transparent',
              color: tab === t ? 'var(--text)' : 'var(--muted)',
              border: tab === t ? '1px solid var(--border)' : 'none',
              borderRadius: 9,
            }}>
              {t === 'transactions' ? 'Transactions' : 'How to Deposit'}
            </button>
          ))}
        </div>

        {/* Transactions */}
        {tab === 'transactions' && (
          loading ? (
            <div style={{ textAlign: 'center', padding: '3rem' }}><span className="spinner spinner-lg" /></div>
          ) : txns.length === 0 ? (
            <div className="empty-state">
              <div style={{ fontSize: '2.5rem', marginBottom: '.8rem' }}>📋</div>
              <div>No {CUR} transactions yet</div>
            </div>
          ) : (
            <div>
              {groups.map(group => (
                <div key={group.label} style={{ marginBottom: '1.2rem' }}>
                  <div style={{ fontSize: '.75rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: '.6rem' }}>
                    {group.label}
                  </div>
                  <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    {group.txns.map((t, i) => (
                      <div key={t.txn_id} style={{
                        display: 'flex', alignItems: 'center', padding: '1rem 1.2rem',
                        borderBottom: i < group.txns.length - 1 ? '1px solid var(--border)' : 'none',
                        gap: '.9rem',
                      }}>
                        <div style={{
                          width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
                          display: 'grid', placeItems: 'center', fontSize: '1rem',
                          background: t.direction === 'credit' ? 'rgba(16,217,178,.12)' : 'rgba(244,63,94,.12)',
                        }}>
                          {t.direction === 'credit' ? '↙' : '↗'}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: '.88rem', color: 'var(--text)' }}>{TYPE_LABELS[t.type] ?? t.type}</div>
                          <div style={{ fontSize: '.74rem', color: 'var(--muted)', marginTop: '.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {t.description}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontWeight: 700, color: t.direction === 'credit' ? 'var(--accent2)' : 'var(--danger)', fontSize: '.9rem' }}>
                            {t.direction === 'credit' ? '+' : '−'} {parseFloat(t.amount).toLocaleString('en-CA', { minimumFractionDigits: 2 })}
                          </div>
                          <div style={{ fontSize: '.72rem', color: 'var(--muted)', marginTop: '.1rem' }}>
                            {new Date(t.created_at).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {/* Deposit info */}
        {tab === 'deposit' && (
          <div>
            {!deposit || depositFields.length === 0 ? (
              <div className="empty-state">
                <div style={{ fontSize: '2rem', marginBottom: '.8rem' }}>💬</div>
                <div>Contact support for {CUR} deposit instructions.</div>
              </div>
            ) : (
              <>
                <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: '1rem' }}>
                  {depositFields.map(([label, val]) => (
                    <div
                      key={label}
                      onClick={() => copyToClipboard(val)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '1rem 1.2rem', borderBottom: '1px solid var(--border)',
                        cursor: 'pointer', gap: '1rem',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: '.72rem', color: 'var(--muted)', marginBottom: '.2rem' }}>{label}</div>
                        <div style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '.9rem', wordBreak: 'break-all', color: 'var(--text)' }}>{val}</div>
                      </div>
                      <span style={{ color: 'var(--accent2)', fontSize: '.74rem', flexShrink: 0 }}>Copy</span>
                    </div>
                  ))}
                </div>
                <div style={{ padding: '.8rem 1rem', background: 'rgba(139,92,246,.08)', borderRadius: 10, fontSize: '.82rem', color: 'var(--muted)' }}>
                  💡 Use your <strong style={{ color: 'var(--text)' }}>registered email</strong> as the payment reference so we can match your deposit.
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
