import { NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

const navItems = [
  { to: '/dashboard',    label: 'Home',     icon: '⊞' },
  { to: '/send',         label: 'Send',     icon: '↗' },
  { to: '/pay',          label: 'Pay',      icon: '🏦' },
  { to: '/exchange',     label: 'Exchange', icon: '⇄' },
  { to: '/deposit',      label: 'Deposit',  icon: '↙' },
  { to: '/transactions', label: 'History',  icon: '≡' },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/');
  }

  return (
    <div className="app-layout">

      {/* ── Mobile top header (hidden on desktop) ── */}
      <header className="app-mobile-header">
        <div style={{ fontSize: '1rem', fontWeight: 700 }}>
          Zeeh <span style={{ color: 'var(--accent2)' }}>Africa</span>
        </div>
        <NavLink
          to="/profile"
          style={{ display: 'flex', alignItems: 'center', gap: '.4rem', color: 'var(--muted)', fontSize: '.82rem', textDecoration: 'none' }}
        >
          <span>👤</span>
          <span>{user?.first_name}</span>
        </NavLink>
      </header>

      {/* ── Desktop sidebar (hidden on mobile) ── */}
      <aside className="app-sidebar">
        {/* Brand */}
        <div style={{ padding: '0 1.4rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>
            Zeeh <span style={{ color: 'var(--accent2)' }}>Africa</span>
          </div>
          <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginTop: '.15rem' }}>
            {user?.first_name} {user?.last_name}
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '1rem .8rem', display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `app-nav-item${isActive ? ' active' : ''}`}
            >
              <span style={{ fontSize: '1rem' }}>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div style={{ padding: '.8rem', borderTop: '1px solid var(--border)' }}>
          <NavLink
            to="/profile"
            className={({ isActive }) => `app-nav-item${isActive ? ' active' : ''}`}
          >
            <span>👤</span> Profile
          </NavLink>
          <button className="app-nav-btn" onClick={handleLogout}>
            <span>⏻</span> Sign out
          </button>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="app-main">
        {children}
      </main>

      {/* ── Mobile bottom nav (hidden on desktop) ── */}
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
