/**
 * Credit Passport — Nigerian FICO score (CRC) + Canadian credit stub.
 *
 * States:
 *  no-data   → "Set up your Credit Passport" + BVN entry
 *  loading   → spinner
 *  loaded    → Nigerian panel + Canadian panel
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
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
  return Number(n).toLocaleString('en-NG');
}

function ScoreDial({ score }: { score: number }) {
  const rating  = getRating(score);
  const colour  = RATING_COLOUR[rating];
  const pct     = ((score - 300) / 550) * 100;
  // SVG arc progress
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

export default function Credit() {
  const [credit,     setCredit]     = useState<CreditData | null | undefined>(undefined);
  const [bvn,        setBvn]        = useState('');
  const [setting,    setSetting]    = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    api.get('/me/credit').then(r => setCredit(r.data.data)).catch(() => setCredit(null));
  }, []);

  async function handleSetup(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{11}$/.test(bvn)) { toast('BVN must be exactly 11 digits', 'err'); return; }
    setSetting(true);
    try {
      const { data } = await api.post('/me/credit/setup', { bvn });
      setCredit({ nigerian_report: data.data.nigerian_report, canadian_report: null, updated_at: new Date().toISOString() });
      setBvn('');
      toast('Credit passport ready ✅');
    } catch (err: unknown) {
      toast((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Could not fetch credit report', 'err');
    } finally { setSetting(false); }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const { data } = await api.post('/me/credit/refresh');
      setCredit({ nigerian_report: data.data.nigerian_report, canadian_report: null, updated_at: data.data.updated_at });
      toast('Credit report updated ✅');
    } catch (err: unknown) {
      toast((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Refresh failed', 'err');
    } finally { setRefreshing(false); }
  }

  // ── Loading ──
  if (credit === undefined) return (
    <div style={{ textAlign: 'center', padding: '4rem 0' }}>
      <span className="spinner spinner-lg" />
    </div>
  );

  // ── Setup screen ──
  if (!credit || !credit.nigerian_report) return (
    <div style={{ maxWidth: 500 }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '.4rem' }}>Credit Passport</h1>
        <p style={{ color: 'var(--muted)', fontSize: '.88rem', lineHeight: 1.7 }}>
          See your Nigerian FICO credit score alongside your Canadian credit profile — all in one place.
          Your credit history travels with you.
        </p>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.7rem', marginBottom: '1.2rem' }}>
          {[
            ['🇳🇬', 'Nigerian FICO score from CRC Credit Bureau'],
            ['🇨🇦', 'Canadian credit profile (Equifax — coming soon)'],
            ['📊', 'Tips to build your Canadian credit history'],
          ].map(([icon, text]) => (
            <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '.7rem', fontSize: '.86rem', color: 'var(--muted)' }}>
              <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{icon}</span>
              <span>{text}</span>
            </div>
          ))}
        </div>

        <form onSubmit={handleSetup} style={{ display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
          <div>
            <label style={{ fontSize: '.82rem', color: 'var(--muted)', display: 'block', marginBottom: '.3rem' }}>
              Your Nigerian BVN (11 digits)
            </label>
            <input
              type="text" inputMode="numeric" maxLength={11}
              placeholder="12345678901"
              value={bvn} onChange={e => setBvn(e.target.value.replace(/\D/g, ''))}
              style={{ fontFamily: 'monospace', letterSpacing: '.1em', fontSize: '1rem' }}
              required
            />
          </div>
          <p style={{ fontSize: '.75rem', color: 'var(--muted)', margin: 0 }}>
            Your BVN is encrypted at rest and only used to fetch your credit report.
            It is never shared or displayed.
          </p>
          <button className="btn btn-primary" disabled={setting || bvn.length !== 11}>
            {setting ? <span className="spinner" /> : 'Pull My Credit Report'}
          </button>
        </form>
      </div>
    </div>
  );

  // ── Report screen ──
  const ng = credit.nigerian_report!;
  const rating = getRating(ng.fico_score);
  const colour = RATING_COLOUR[rating];
  const reasons = ng.fico_reasons?.split('. ').filter(Boolean) ?? [];

  return (
    <div style={{ maxWidth: 600 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 700 }}>Credit Passport</h1>
          <div style={{ fontSize: '.75rem', color: 'var(--muted)' }}>
            Last updated {new Date(credit.updated_at).toLocaleDateString('en-CA', { day: 'numeric', month: 'short', year: 'numeric' })}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? <span className="spinner" /> : '↻ Refresh'}
        </button>
      </div>

      {/* Nigerian panel */}
      <div className="card" style={{ marginBottom: '1rem', borderColor: `${colour}44` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '1.2rem' }}>
          <span style={{ fontSize: '1.2rem' }}>🇳🇬</span>
          <span style={{ fontWeight: 700, fontSize: '.95rem' }}>Nigerian Credit Score</span>
          <span style={{ marginLeft: 'auto', fontSize: '.72rem', color: 'var(--muted)' }}>CRC Bureau · FICO</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', marginBottom: '1.2rem' }}>
          <ScoreDial score={ng.fico_score} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.6rem', flex: 1 }}>
            {[
              ['Total Loans',    ng.total_loans],
              ['Active',         ng.active_loans],
              ['Institutions',   ng.institutions],
              ['Delinquencies',  ng.delinquent_facilities],
            ].map(([label, val]) => (
              <div key={label as string} className="card" style={{ padding: '.6rem .8rem', textAlign: 'center' }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{val}</div>
                <div style={{ fontSize: '.68rem', color: 'var(--muted)' }}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Totals */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '.5rem', marginBottom: '1rem' }}>
          {[
            ['Total Borrowed',  `₦${fmt(ng.total_borrowed)}`],
            ['Outstanding',     `₦${fmt(ng.total_outstanding)}`],
            ['Overdue',         `₦${fmt(ng.total_overdue)}`],
          ].map(([label, val]) => (
            <div key={label as string} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '.82rem', fontWeight: 600 }}>{val}</div>
              <div style={{ fontSize: '.65rem', color: 'var(--muted)' }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Lender summary */}
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

        {/* Improvement tips */}
        {reasons.length > 0 && (
          <div style={{ marginTop: '1rem', padding: '.8rem 1rem', background: 'rgba(245,158,11,.07)', borderRadius: 10, borderLeft: '3px solid var(--warn)' }}>
            <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--warn)', marginBottom: '.4rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>How to improve</div>
            {reasons.slice(0, 2).map((r, i) => (
              <div key={i} style={{ fontSize: '.8rem', color: 'var(--muted)', marginBottom: '.25rem' }}>· {r}.</div>
            ))}
          </div>
        )}
      </div>

      {/* Canadian panel */}
      <div className="card" style={{ borderStyle: 'dashed', opacity: 0.8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '1rem' }}>
          <span style={{ fontSize: '1.2rem' }}>🇨🇦</span>
          <span style={{ fontWeight: 700, fontSize: '.95rem' }}>Canadian Credit Score</span>
          <span style={{ marginLeft: 'auto', fontSize: '.7rem', padding: '2px 8px', borderRadius: 20, background: 'rgba(245,158,11,.15)', color: 'var(--warn)', fontWeight: 600 }}>Coming Soon</span>
        </div>
        <p style={{ fontSize: '.84rem', color: 'var(--muted)', lineHeight: 1.7, margin: 0 }}>
          We're integrating with Equifax Canada to show your Canadian credit score here.
          Once live, you'll see both scores side by side — the full picture of your credit journey.
        </p>
        <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
          <div style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--muted)' }}>Tips to start building Canadian credit:</div>
          {[
            '🏦 Open a Canadian chequing account (you may already have one)',
            '💳 Apply for a secured credit card — no history required',
            '📱 Register a phone plan in your name',
            '🏠 Ask your landlord to report rent to the bureau',
          ].map(tip => (
            <div key={tip} style={{ fontSize: '.78rem', color: 'var(--muted)' }}>{tip}</div>
          ))}
        </div>
      </div>

      {/* Disclaimer */}
      <p style={{ fontSize: '.7rem', color: 'var(--muted)', marginTop: '1rem', lineHeight: 1.6 }}>
        Nigerian score sourced from CRC Credit Bureau via your BVN. Canadian score integration
        coming soon via Equifax Canada. Data refreshed on demand only — your BVN is encrypted
        at rest and never shared.
      </p>
    </div>
  );
}
