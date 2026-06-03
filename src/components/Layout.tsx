import { NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

// Bottom nav order = revenue priority: Exchange + Pay front and centre
const navItems = [
  { to: '/dashboard',    label: 'Home',     icon: '⊞' },
  { to: '/exchange',     label: 'Exchange', icon: '⇄' },
  { to: '/pay',          label: 'Pay',      icon: '🏦' },
  { to: '/credit',       label: 'Credit',   icon: '📊' },
  { to: '/transactions', label: 'History',  icon: '≡' },
];

// These appear in the desktop sidebar but are not crammed into the 5-item mobile bottom nav
const sidebarExtra = [
  { to: '/send',          label: 'Send',          icon: '↗' },
  { to: '/beneficiaries', label: 'Beneficiaries', icon: '👥' },
];

// Uses CSS variable so dark/light modes get proper contrast automatically
const TEXT_GRADIENT: React.CSSProperties = {
  background: 'var(--g-brand)',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const initials = ((user?.first_name?.[0] ?? '') + (user?.last_name?.[0] ?? '')).toUpperCase();

  function handleLogout() {
    logout();
    navigate('/');
  }

  return (
    <div className="app-layout">

      {/* ── Mobile top header ── */}
      <header className="app-mobile-header">
        <div style={{ fontSize: '1.05rem', fontWeight: 700, ...TEXT_GRADIENT }}>
          Zeeh Africa
        </div>
        <NavLink to="/profile" style={{ textDecoration: 'none' }}>
          <div style={{
            width: 34, height: 34, borderRadius: '50%',
            background: 'var(--g-brand)',
            display: 'grid', placeItems: 'center',
            fontSize: '.78rem', fontWeight: 700, color: '#fff',
          }}>
            {initials || '👤'}
          </div>
        </NavLink>
      </header>

      {/* ── Desktop sidebar ── */}
      <aside className="app-sidebar">
        {/* Brand */}
        <div style={{ padding: '0 1.4rem 1.5rem', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '.3rem', ...TEXT_GRADIENT }}>
            Zeeh Africa
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
            <div style={{
              width: 24, height: 24, borderRadius: '50%',
              background: 'var(--g-brand)',
              display: 'grid', placeItems: 'center',
              fontSize: '.65rem', fontWeight: 700, color: '#fff', flexShrink: 0,
            }}>
              {initials || '?'}
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.first_name} {user?.last_name}
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '1rem .6rem', display: 'flex', flexDirection: 'column', gap: '.15rem' }}>
          {[...navItems, ...sidebarExtra].map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `app-nav-item${isActive ? ' active' : ''}`}
            >
              <span style={{ fontSize: '1rem', width: 20, textAlign: 'center' }}>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div style={{ padding: '.6rem', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <NavLink
            to="/profile"
            className={({ isActive }) => `app-nav-item${isActive ? ' active' : ''}`}
          >
            <span style={{ fontSize: '1rem', width: 20, textAlign: 'center' }}>👤</span>
            Profile
          </NavLink>
          <button className="app-nav-btn" onClick={handleLogout}>
            <span style={{ fontSize: '1rem', width: 20, textAlign: 'center' }}>⏻</span>
            Sign out
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="app-main">
        {children}
      </main>

      {/* ── Mobile bottom nav ── */}
      <nav className="app-bottom-nav">
        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => isActive ? 'active' : ''}
          >
            <span className="bnav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

    </div>
  );
}
