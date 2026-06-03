import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from './store/authStore';
import Layout from './components/Layout';
import { ToastContainer } from './components/Toast';

import Auth           from './pages/Auth';
import ResetPassword   from './pages/ResetPassword';
import Dashboard       from './pages/Dashboard';
import Send            from './pages/Send';
import Pay             from './pages/Pay';
import Exchange        from './pages/Exchange';
import Deposit         from './pages/Deposit';
import Transactions    from './pages/Transactions';
import Profile         from './pages/Profile';
import Beneficiaries   from './pages/Beneficiaries';
import CurrencyWallet  from './pages/CurrencyWallet';
import Credit          from './pages/Credit';

/** Intercepts the Android hardware back button.
 *
 * Registered ONCE via empty deps. Uses refs for navigate + pathname
 * so the closure always sees fresh values without re-registering
 * (re-registering caused duplicate listeners firing on every navigation).
 */
function AndroidBackHandler() {
  const navigate     = useNavigate();
  const location     = useLocation();
  const navigateRef  = useRef(navigate);
  const pathRef      = useRef(location.pathname);
  const ROOT_PATHS   = ['/dashboard', '/'];

  // Keep refs current
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);
  useEffect(() => { pathRef.current = location.pathname; }, [location.pathname]);

  useEffect(() => {
    let mounted = true;
    let handle: { remove: () => void } | null = null;

    import('@capacitor/app').then(({ App: CapApp }) => {
      if (!mounted) return;
      CapApp.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack && !ROOT_PATHS.includes(pathRef.current)) {
          navigateRef.current(-1);
        } else {
          CapApp.exitApp();
        }
      }).then(h => {
        if (!mounted) h.remove();   // component unmounted before promise resolved
        else handle = h;
      });
    });

    return () => {
      mounted = false;
      handle?.remove();
    };
  }, []); // ← empty: register exactly once for the lifetime of the app

  return null;
}

/**
 * Inactivity logout — 10 minutes with no interaction.
 * Absolute session — 24 hours from login, regardless of activity.
 * Tracks: click, touchstart, keypress.
 *
 * Timer is PAUSED when the app goes to background (file picker, other app, etc.)
 * so switching to file manager mid-KYC doesn't trigger logout. On resume we
 * compare the wall-clock elapsed time against lastActiveAt instead.
 */
const INACTIVITY_MS  = 10 * 60 * 1000;       // 10 minutes
const SESSION_MAX_MS = 24 * 60 * 60 * 1000;  // 24 hours absolute session

function SessionGuard() {
  const { logout, user, loginAt, lastActiveAt, touchActive } = useAuthStore();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkExpiry = useCallback(() => {
    if (!user) return;
    const now = Date.now();
    if (loginAt      && now - loginAt      > SESSION_MAX_MS) { logout(); return; }
    if (lastActiveAt && now - lastActiveAt > INACTIVITY_MS)  { logout(); return; }
  }, [user, loginAt, lastActiveAt, logout]);

  const resetTimer = useCallback(() => {
    touchActive();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(logout, INACTIVITY_MS);
  }, [logout, touchActive]);

  const pauseTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Stable refs so the appStateChange listener never needs to re-register
  const checkExpiryRef = useRef(checkExpiry);
  const resetTimerRef  = useRef(resetTimer);
  useEffect(() => { checkExpiryRef.current = checkExpiry; }, [checkExpiry]);
  useEffect(() => { resetTimerRef.current  = resetTimer;  }, [resetTimer]);

  // On every mount: check if session/idle has already expired
  useEffect(() => {
    checkExpiry();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Activity listeners — browser + Android WebView touch/click/keyboard
  useEffect(() => {
    if (!user) return;
    const events = ['click', 'touchstart', 'keypress'] as const;
    events.forEach(e => window.addEventListener(e, resetTimer, { passive: true }));
    resetTimer();
    return () => {
      events.forEach(e => window.removeEventListener(e, resetTimer));
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [user, resetTimer]);

  // Capacitor foreground/background — pause timer on background, recheck on resume.
  // This prevents the timer firing while the user is legitimately in another app
  // (e.g. file manager during KYC document upload).
  useEffect(() => {
    if (!user) return;
    let handle: { remove: () => void } | null = null;
    import('@capacitor/app').then(({ App: CapApp }) => {
      CapApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          // Back in foreground: check wall-clock elapsed time, then restart timer
          checkExpiryRef.current();
          if (useAuthStore.getState().user) resetTimerRef.current();
        } else {
          // Going to background: pause the countdown — don't fire while user is away
          pauseTimer();
        }
      }).then(h => { handle = h; });
    });
    return () => { handle?.remove(); };
  }, [user, pauseTimer]); // stable — refs handle the rest

  return null;
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore(s => s.user);
  return user ? <>{children}</> : <Navigate to="/" replace />;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore(s => s.user);
  return user ? <Navigate to="/dashboard" replace /> : <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AndroidBackHandler />
      <SessionGuard />
      <Routes>
        <Route path="/" element={<PublicRoute><Auth /></PublicRoute>} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/*" element={
          <PrivateRoute>
            <Layout>
              <Routes>
                <Route path="/dashboard"    element={<Dashboard />} />
                <Route path="/send"         element={<Send />} />
                <Route path="/pay"          element={<Pay />} />
                <Route path="/exchange"     element={<Exchange />} />
                <Route path="/deposit"      element={<Deposit />} />
                <Route path="/transactions" element={<Transactions />} />
                <Route path="/profile"        element={<Profile />} />
                <Route path="/beneficiaries"       element={<Beneficiaries />} />
                <Route path="/wallet/:currency"    element={<CurrencyWallet />} />
                <Route path="/credit"              element={<Credit />} />
                <Route path="*"              element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </Layout>
          </PrivateRoute>
        } />
      </Routes>
      <ToastContainer />
    </BrowserRouter>
  );
}
