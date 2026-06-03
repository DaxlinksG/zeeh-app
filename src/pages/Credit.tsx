/**
 * Credit Passport
 *
 * Flow:
 *  1. Country picker — user selects which country's credit history to connect.
 *     Nigeria is live; others show "coming soon".
 *  2. Per-country form — e.g. Nigeria shows BVN entry.
 *  3. Report view — connected bureau panels + more-coming list.
 */

import { useState, useEffect } from 'react';
import api from '../lib/api';
import { toast } from '../components/Toast';

// ── Types ──────────────────────────────────────────────────────────────────

interface LoanPerformance {
  loanProvider:      string;
  loanAmount:        string;
  status:            string;
  performanceStatus: string;
  overdueAmount:     string;
  outstandingBalance:string;
}

interface NigerianReport {
  fico_score:              number;
  fico_rating:             string;
  fico_reasons:            string;
  total_loans:             number;
  active_loans:            number;
  closed_loans:            number;
  delinquent_facilities:   number;
  total_borrowed:          number;
  total_outstanding:       number;
  total_overdue:           number;
  institutions:            number;
  credit_enquiries:        { loanType: string; date: string; institutionType: string }[];
  loan_performance:        LoanPerformance[];
  last_reported_date:      string;
  report_order_number:     string;
  fetched_at:              string;
}

interface CreditData {
  nigerian_report: NigerianReport | null;
  canadian_report: null;
  updated_at:      string;
  next_refresh_at: string | null;
}

// ── Bureau catalogue ───────────────────────────────────────────────────────

interface Bureau {
  key:       string;
  flag:      string;
  country:   string;
  provider:  string;
  idLabel:   string;  // what the ID is called
  live:      boolean;
}

const BUREAUS: Bureau[] = [
  { key: 'nigeria',  flag: '🇳🇬', country: 'Nigeria',       provider: 'CRC Credit Bureau',          idLabel: 'BVN',                    live: true  },
  { key: 'ghana',    flag: '🇬🇭', country: 'Ghana',          provider: 'Credit Reference Bureau',    idLabel: 'Ghana Card / GhIPSS ID', live: false },
  { key: 'kenya',    flag: '🇰🇪', country: 'Kenya',          provider: 'TransUnion Kenya',            idLabel: 'National ID',            live: false },
  { key: 'canada',   flag: '🇨🇦', country: 'Canada',         provider: 'Equifax Canada',             idLabel: 'SIN',                    live: false },
  { key: 'uk',       flag: '🇬🇧', country: 'United Kingdom', provider: 'Experian UK',                idLabel: 'National Insurance No.',  live: false },
  { key: 'us',       flag: '🇺🇸', country: 'United States',  provider: 'Equifax / TransUnion',       idLabel: 'SSN',                    live: false },
];

// ── Score dial ─────────────────────────────────────────────────────────────

type Rating = 'Exceptional' | 'Very Good' | 'Good' | 'Fair' | 'Poor';

function getRating(score: number): Rating {
  if (score >= 800) return 'Exceptional';
  if (score >= 740) return 'Very Good';
  if (score >= 670) return 'Good';
  if (score >= 580) return 'Fair';
  return 'Poor';
}

const RATING_COLOUR: Record<Rating, string> = {
  Exceptional: '#10d9b2',
  'Very Good':  '#22c55e',
  Good:         '#3b82f6',
  Fair:         '#f59e0b',
  Poor:         '#ef4444',
};

function fmt(n: number | string) {
  return Number(n).toLocaleString();
}

function ScoreDial({ score }: { score: number }) {
  const rating = getRating(score);
  const colour = RATING_COLOUR[rating];
  const pct    = ((score - 300) / 550) * 100;
  const r = 54, cx = 64, cy = 64;
  const circ = 2 * Math.PI * r;
  const dash  = (pct / 100) * circ;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '.5rem' }}>
      <svg width={128} height={128} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={10} />
        <circle cx={cx} cy={cy} r={r} fill="none"
          stroke={colour} strokeWidth={10}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeLinecap="round"
        />
      </svg>
      <div style={{ marginTop: -96, textAlign: 'center', zIndex: 1, position: 'relative' }}>
        <div style={{ fontSize: '2rem', fontWeight: 800, color: colour, lineHeight: 1 }}>{score}</div>
        <div style={{ fontSize: '.75rem', fontWeight: 600, color: colour, marginTop: 2 }}>{rating}</div>
        <div style={{ fontSize: '.65rem', color: 'var(--muted)', marginTop: 1 }}>out of 850</div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

type ApiError = { response?: { data?: { message?: string } } };

export default function Credit() {
  const [credit,      setCredit]      = useState<CreditData | null | undefined>(undefined);
  const [selected,    setSelected]    = useState<Bureau | null>(null);
  const [bvn,         setBvn]         = useState('');
  const [connecting,  setConnecting]  = useState(false);
  const [refreshing,  setRefreshing]  = useState(false);

  useEffect(() => {
    api.get('/me/credit').then(r => setCredit(r.data.data)).catch(() => setCredit(null));
  }, []);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    if (selected.key === 'nigeria' && !/^\d{11}$/.test(bvn)) {
      toast('BVN must be exactly 11 digits', 'err'); return;
    }
    setConnecting(true);
    try {
      const { data } = await api.post('/me/credit/setup', { bvn });
      setCredit({
        nigerian_report: data.data.nigerian_report,
        canadian_report: null,
        updated_at:      new Date().toISOString(),
        next_refresh_at: null,
      });
      setSelected(null);
      setBvn('');
      toast('Credit report connected');
    } catch (err: unknown) {
      toast((err as ApiError)?.response?.data?.message ?? 'Could not connect credit report', 'err');
    } finally { setConnecting(false); }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const { data } = await api.post('/me/credit/refresh');
      setCredit({
        nigerian_report: data.data.nigerian_report,
        canadian_report: null,
        updated_at:      data.data.updated_at,
        next_refresh_at: data.data.next_refresh_at,
      });
      toast('Credit report updated');
    } catch (err: unknown) {
      toast((err as ApiError)?.response?.data?.message ?? 'Refresh failed', 'err');
    } finally { setRefreshing(false); }
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (credit === undefined) return (
    <div style={{ textAlign: 'center', padding: '4rem 0' }}>
      <span className="spinner spinner-lg" />
    </div>
  );

  // ── Connect form (after user picks a bureau) ──────────────────────────────
  if (selected) return (
    <div style={{ maxWidth: 480 }}>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: '1.2rem' }}
        onClick={() => { setSelected(null); setBvn(''); }}>
        ← Back
      </button>
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.4rem' }}>
          <span style={{ fontSize: '1.6rem' }}>{selected.flag}</span>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 700 }}>{selected.country} Credit</h1>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: '.88rem', lineHeight: 1.7 }}>
          Connect your {selected.country} credit history via {selected.provider}.
          We verify your identity before connecting — please use your own credentials.
        </p>
      </div>

      <form className="card" onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
        {selected.key === 'nigeria' && (
          <div>
            <label style={{ fontSize: '.82rem', color: 'var(--muted)', display: 'block', marginBottom: '.3rem' }}>
              {selected.idLabel} — Bank Verification Number (11 digits)
            </label>
            <input
              type="text" inputMode="numeric" maxLength={11}
              placeholder="12345678901"
              value={bvn} onChange={e => setBvn(e.target.value.replace(/\D/g, ''))}
              style={{ fontFamily: 'monospace', letterSpacing: '.1em', fontSize: '1rem' }}
              required
            />
          </div>
        )}
        <p style={{ fontSize: '.75rem', color: 'var(--muted)', margin: 0 }}>
          Your ID is encrypted at rest and only used to fetch your credit report.
          It is never shared or displayed.
        </p>
        <button className="btn btn-primary" disabled={connecting || (selected.key === 'nigeria' && bvn.length !== 11)}>
          {connecting ? <span className="spinner" /> : 'Connect Credit Report'}
        </button>
      </form>
    </div>
  );

  // ── No credit connected yet — show country picker ─────────────────────────
  if (!credit || !credit.nigerian_report) return (
    <div style={{ maxWidth: 520 }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '.4rem' }}>Credit Passport</h1>
        <p style={{ color: 'var(--muted)', fontSize: '.88rem', lineHeight: 1.7 }}>
          Connect your credit history from your home country. We'll display it alongside
          scores from wherever you are now — all in one place.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
        {BUREAUS.map(b => (
          <div key={b.key} className="card" style={{
            display: 'flex', alignItems: 'center', gap: '.9rem',
            opacity: b.live ? 1 : 0.6,
          }}>
            <span style={{ fontSize: '1.6rem', flexShrink: 0 }}>{b.flag}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: '.92rem' }}>{b.country}</div>
              <div style={{ fontSize: '.75rem', color: 'var(--muted)' }}>{b.provider}</div>
            </div>
            {b.live ? (
              <button className="btn btn-sm btn-primary" style={{ flexShrink: 0 }}
                onClick={() => setSelected(b)}>
                Connect
              </button>
            ) : (
              <span style={{
                fontSize: '.72rem', padding: '3px 10px', borderRadius: 20, flexShrink: 0,
                background: 'rgba(245,158,11,.12)', color: 'var(--warn)', fontWeight: 600,
              }}>
                Coming soon
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  // ── Report view ───────────────────────────────────────────────────────────
  const ng      = credit.nigerian_report!;
  const rating  = getRating(ng.fico_score);
  const colour  = RATING_COLOUR[rating];
  const reasons = ng.fico_reasons?.split('. ').filter(Boolean) ?? [];

  const nextRefresh    = credit.next_refresh_at ? new Date(credit.next_refresh_at) : null;
  const refreshBlocked = nextRefresh !== null && new Date() < nextRefresh;
  const nextRefreshStr = nextRefresh
    ? nextRefresh.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  return (
    <div style={{ maxWidth: 600 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 700 }}>Credit Passport</h1>
          <div style={{ fontSize: '.75rem', color: 'var(--muted)' }}>
            Last updated {new Date(credit.updated_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '.2rem' }}>
          <button className="btn btn-ghost btn-sm" onClick={handleRefresh}
            disabled={refreshing || refreshBlocked}
            title={refreshBlocked ? `Next refresh: ${nextRefreshStr}` : undefined}>
            {refreshing ? <span className="spinner" /> : '↻ Refresh'}
          </button>
          {refreshBlocked && nextRefreshStr && (
            <span style={{ fontSize: '.65rem', color: 'var(--muted)' }}>Available {nextRefreshStr}</span>
          )}
        </div>
      </div>

      {/* Nigeria — CRC Bureau */}
      <div className="card" style={{ marginBottom: '1rem', borderColor: `${colour}44` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '1.2rem' }}>
          <span style={{ fontSize: '1.2rem' }}>🇳🇬</span>
          <span style={{ fontWeight: 700, fontSize: '.95rem' }}>Credit Score</span>
          <span style={{ marginLeft: 'auto', fontSize: '.72rem', color: 'var(--muted)' }}>CRC Bureau · Nigeria</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', marginBottom: '1.2rem' }}>
          <ScoreDial score={ng.fico_score} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.6rem', flex: 1 }}>
            {([
              ['Total Loans',    ng.total_loans],
              ['Active',         ng.active_loans],
              ['Institutions',   ng.institutions],
              ['Delinquencies',  ng.delinquent_facilities],
            ] as [string, number][]).map(([label, val]) => (
              <div key={label} className="card" style={{ padding: '.6rem .8rem', textAlign: 'center' }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{val}</div>
                <div style={{ fontSize: '.68rem', color: 'var(--muted)' }}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '.5rem', marginBottom: '1rem' }}>
          {([
            ['Total Borrowed',  `₦${fmt(ng.total_borrowed)}`],
            ['Outstanding',     `₦${fmt(ng.total_outstanding)}`],
            ['Overdue',         `₦${fmt(ng.total_overdue)}`],
          ] as [string, string][]).map(([label, val]) => (
            <div key={label} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '.82rem', fontWeight: 600 }}>{val}</div>
              <div style={{ fontSize: '.65rem', color: 'var(--muted)' }}>{label}</div>
            </div>
          ))}
        </div>

        {ng.loan_performance.length > 0 && (
          <div>
            <div style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: '.5rem' }}>
              Lenders
            </div>
            {ng.loan_performance.slice(0, 4).map((l, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '.45rem 0', borderBottom: i < Math.min(ng.loan_performance.length, 4) - 1 ? '1px solid var(--border)' : 'none', fontSize: '.82rem' }}>
                <div>
                  <span style={{ fontWeight: 600 }}>{l.loanProvider}</span>
                  <span style={{ color: 'var(--muted)', marginLeft: '.4rem' }}>{l.loanAmount}</span>
                </div>
                <span style={{ fontSize: '.72rem', padding: '2px 8px', borderRadius: 20, background: l.performanceStatus === 'Performing' ? 'rgba(16,217,178,.15)' : 'rgba(244,63,94,.15)', color: l.performanceStatus === 'Performing' ? '#10d9b2' : '#f43f5e' }}>
                  {l.status}
                </span>
              </div>
            ))}
          </div>
        )}

        {reasons.length > 0 && (
          <div style={{ marginTop: '1rem', padding: '.8rem 1rem', background: 'rgba(245,158,11,.07)', borderRadius: 10, borderLeft: '3px solid var(--warn)' }}>
            <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--warn)', marginBottom: '.4rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>How to improve</div>
            {reasons.slice(0, 2).map((r, i) => (
              <div key={i} style={{ fontSize: '.8rem', color: 'var(--muted)', marginBottom: '.25rem' }}>· {r}.</div>
            ))}
          </div>
        )}
      </div>

      {/* Coming-soon bureaus */}
      <div style={{ marginBottom: '.5rem' }}>
        <div style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: '.6rem' }}>
          More coming soon
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
          {BUREAUS.filter(b => !b.live).map(b => (
            <div key={b.key} className="card" style={{ display: 'flex', alignItems: 'center', gap: '.8rem', opacity: 0.55, padding: '.7rem 1rem' }}>
              <span style={{ fontSize: '1.3rem' }}>{b.flag}</span>
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 600, fontSize: '.88rem' }}>{b.country}</span>
                <span style={{ color: 'var(--muted)', fontSize: '.75rem', marginLeft: '.5rem' }}>{b.provider}</span>
              </div>
              <span style={{ fontSize: '.7rem', padding: '2px 8px', borderRadius: 20, background: 'rgba(245,158,11,.12)', color: 'var(--warn)', fontWeight: 600 }}>
                Coming soon
              </span>
            </div>
          ))}
        </div>
      </div>

      <p style={{ fontSize: '.7rem', color: 'var(--muted)', marginTop: '1rem', lineHeight: 1.6 }}>
        Score sourced from CRC Credit Bureau via your BVN. Your ID is encrypted at rest and never shared.
        Refreshes are limited to once every 30 days.
      </p>
    </div>
  );
}
