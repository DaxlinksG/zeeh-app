import { NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

const navItems = [
  { to: '/dashboard',    label: 'Home',         icon: '⊞' },
  { to: '/send',         label: 'Send',         icon: '↗' },
  { to: '/pay',          label: 'Pay',          icon: '🏦' },
  { to: '/exchange',     label: 'Exchange',     icon: '⇄' },
  { to: '/deposit',      label: 'Deposit',      icon: '↙' },
  { to: '/transactions', label: 'History',      icon: '≡' },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/');
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar */}
      <aside style={{
        width: 220,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        padding: '1.5rem 0',
        flexShrink: 0,
      }}>
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
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: '.7rem',
                padding: '.6rem .8rem',
                borderRadius: 8,
                fontSize: '.9rem',
                fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--text)' : 'var(--muted)',
                background: isActive ? 'rgba(108,99,255,.12)' : 'transparent',
                transition: 'all .15s',
              })}
            >
              <span style={{ fontSize: '1rem' }}>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div style={{ padding: '.8rem', borderTop: '1px solid var(--border)' }}>
          <NavLink to="/profile" style={({ isActive }) => ({
            display: 'flex', alignItems: 'center', gap: '.7rem',
            padding: '.6rem .8rem', borderRadius: 8, fontSize: '.9rem',
            color: isActive ? 'var(--text)' : 'var(--muted)',
            background: isActive ? 'rgba(108,99,255,.12)' : 'transparent',
          })}>
            <span>👤</span> Profile
          </NavLink>
          <button
            onClick={handleLogout}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: '.7rem',
              padding: '.6rem .8rem', borderRadius: 8, fontSize: '.9rem',
              color: 'var(--muted)', background: 'transparent', border: 'none',
              cursor: 'pointer', marginTop: '.2rem',
            }}
          >
            <span>⏻</span> Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, overflowY: 'auto', padding: '2rem' }}>
        {children}
      </main>
    </div>
  );
}
