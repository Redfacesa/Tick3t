import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { REDFACE_PAY_ORIGIN } from '@/lib/company';
import { checkTick3tIsAdmin } from '@/lib/tick3t/api';
import { cls } from '@/lib/format';

const NAV = [
  { to: '/', label: 'Events', end: true },
  { to: '/tickets', label: 'My tickets' },
  { to: '/organizer', label: 'Organizer' },
  { to: '/staff', label: 'Staff' },
];

export default function Tick3tShell({ children }: { children?: ReactNode }) {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    void checkTick3tIsAdmin(user.email).then(setIsAdmin);
  }, [user]);

  return (
    <div className="flex min-h-screen flex-col bg-[#0a0a0a] text-white">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0a0a0a]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <img
              src="/tick3t/wordmark.png"
              alt="Tick3t"
              className="h-7 w-auto object-contain sm:h-8"
              onError={(e) => {
                const img = e.currentTarget;
                if (img.src.includes('wordmark')) img.src = '/tick3t/icon.png';
              }}
            />
          </Link>
          <nav className="flex flex-1 items-center justify-end gap-1 overflow-x-auto sm:gap-2">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cls(
                    'shrink-0 rounded-lg px-2.5 py-2 text-xs font-semibold transition sm:px-3 sm:text-sm',
                    isActive || (item.to !== '/' && location.pathname.startsWith(item.to))
                      ? 'bg-[#FF4B4B]/15 text-[#FF4B4B]'
                      : 'text-white/55 hover:text-white',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
            {isAdmin && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  cls(
                    'shrink-0 rounded-lg px-2.5 py-2 text-xs font-semibold transition sm:px-3 sm:text-sm',
                    isActive ? 'bg-[#FF4B4B]/15 text-[#FF4B4B]' : 'text-white/55 hover:text-white',
                  )
                }
              >
                Admin
              </NavLink>
            )}
            {user ? (
              <button
                type="button"
                onClick={() => void signOut()}
                className="shrink-0 rounded-lg px-2.5 py-2 text-xs font-semibold text-white/55 hover:text-white sm:px-3 sm:text-sm"
              >
                Sign out
              </button>
            ) : (
              <Link
                to={`/login?return_url=${encodeURIComponent(location.pathname + location.search)}`}
                className="shrink-0 rounded-lg px-2.5 py-2 text-xs font-semibold text-[#FF4B4B] sm:px-3 sm:text-sm"
              >
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:py-8">
        {children ?? <Outlet />}
      </main>

      <footer className="border-t border-white/10 bg-[#111]">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-5 text-center text-xs text-white/45 sm:flex-row sm:items-center sm:justify-between sm:text-left">
          <p>Payments by RedFace Pay</p>
          <p>
            <a href={REDFACE_PAY_ORIGIN} className="hover:text-white/70" rel="noreferrer">
              RedFace Pay
            </a>
            {' · '}
            <a href={`${REDFACE_PAY_ORIGIN}/legal/privacy`} className="hover:text-white/70" rel="noreferrer">
              Privacy
            </a>
            {' · '}
            <a href={`${REDFACE_PAY_ORIGIN}/legal/terms`} className="hover:text-white/70" rel="noreferrer">
              Terms
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
