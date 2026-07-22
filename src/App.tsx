import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/contexts/AuthContext';
import Tick3tShell from '@/components/tick3t/Tick3tShell';

const Tick3tHomePage = lazy(() => import('@/pages/Tick3tHomePage'));
const Tick3tEventPage = lazy(() => import('@/pages/Tick3tEventPage'));
const Tick3tTicketsPage = lazy(() => import('@/pages/Tick3tTicketsPage'));
const Tick3tOrganizerRegisterPage = lazy(() => import('@/pages/Tick3tOrganizerRegisterPage'));
const Tick3tOrganizerDashboard = lazy(() => import('@/pages/Tick3tOrganizerDashboard'));
const Tick3tStaffPage = lazy(() => import('@/pages/Tick3tStaffPage'));
const Tick3tAdminPage = lazy(() => import('@/pages/Tick3tAdminPage'));
const LoginPage = lazy(() => import('@/pages/LoginPage'));

function RouteFallback() {
  return <p className="text-sm text-white/45">Loading…</p>;
}

/** Preserve old /tick3t/* URLs from RedFace Pay. */
function LegacyTick3tRedirect() {
  const { '*': rest } = useParams();
  const target = rest ? `/${rest}` : '/';
  return <Navigate to={target} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster theme="dark" position="top-center" richColors />
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/tick3t" element={<Navigate to="/" replace />} />
            <Route path="/tick3t/*" element={<LegacyTick3tRedirect />} />
            <Route path="/login" element={<LoginPage />} />
            <Route element={<Tick3tShell />}>
              <Route index element={<Tick3tHomePage />} />
              <Route path="events/:slug" element={<Tick3tEventPage />} />
              <Route path="tickets" element={<Tick3tTicketsPage />} />
              <Route path="organizer/register" element={<Tick3tOrganizerRegisterPage />} />
              <Route path="organizer" element={<Tick3tOrganizerDashboard />} />
              <Route path="organizer/events" element={<Tick3tOrganizerDashboard />} />
              <Route path="staff" element={<Tick3tStaffPage />} />
              <Route path="admin" element={<Tick3tAdminPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}
