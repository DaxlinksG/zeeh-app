import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef } from 'react';
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
                <Route path="/beneficiaries" element={<Beneficiaries />} />
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
