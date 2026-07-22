import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { REDFACE_PAY_ORIGIN } from '@/lib/company';
import { checkTick3tIsAdmin } from '@/lib/tick3t/api';
import { cls } from '@/lib/format';

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/#events', label: 'Events', end: false, hash: true },
  { to: '/tickets', label: 'My tickets' },
  { to: '/organizer', label: 'Sell' },
];

export default function Tick3tShell({ children }: { children?: ReactNode }) {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const [isAdmin, setIsAdmin] = useState(false);
  const isHome = location.pathname === '/';

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    void checkTick3tIsAdmin(user.email).then(setIsAdmin);
  }, [user]);

  return (
    <div className="flex min-h-screen flex-col bg-white text-ink">
      <header className="sticky top-0 z-40 border-b border-black/8 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <img
              src="/tick3t/wordmark.png"
              alt="Tick3t"
              className="h-8 w-auto object-contain sm:h-9"
              onError={(e) => {
                const img = e.currentTarget;
                if (img.src.includes('wordmark')) img.src = '/tick3t/icon.png';
              }}
            />
          </Link>
          <nav className="flex flex-1 items-center justify-end gap-1 overflow-x-auto sm:gap-2">
            {NAV.map((item) => {
              if (item.hash) {
                return (
                  <a
                    key={item.to}
                    href={item.to}
                    className="shrink-0 rounded-lg px-2.5 py-2 text-xs font-semibold text-ink/55 transition hover:text-ink sm:px-3 sm:text-sm"
                  >
                    {item.label}
                  </a>
                );
              }
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cls(
                      'shrink-0 rounded-lg px-2.5 py-2 text-xs font-semibold transition sm:px-3 sm:text-sm',
                      isActive || (item.to !== '/' && location.pathname.startsWith(item.to))
                        ? 'bg-brand/10 text-brand'
                        : 'text-ink/55 hover:text-ink',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              );
            })}
            {isAdmin && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  cls(
                    'shrink-0 rounded-lg px-2.5 py-2 text-xs font-semibold transition sm:px-3 sm:text-sm',
                    isActive ? 'bg-brand/10 text-brand' : 'text-ink/55 hover:text-ink',
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
                className="shrink-0 rounded-lg px-2.5 py-2 text-xs font-semibold text-ink/55 hover:text-ink sm:px-3 sm:text-sm"
              >
                Sign out
              </button>
            ) : (
              <Link
                to="/login"
                className="shrink-0 rounded-lg bg-ink px-3 py-2 text-xs font-bold text-white transition hover:bg-ink/90 sm:text-sm"
              >
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className={cls('w-full flex-1', !isHome && 'mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8')}>
        {children ?? <Outlet />}
      </main>

      <footer className="border-t border-black/8 bg-mist">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-center text-xs text-ink/45 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:text-left">
          <p>Payments by RedFace Pay · Co-owned with Entendre</p>
          <p>
            <a href={REDFACE_PAY_ORIGIN} className="hover:text-ink/70" rel="noreferrer">
              RedFace Pay
            </a>
            {' · '}
            <a href={`${REDFACE_PAY_ORIGIN}/legal/privacy`} className="hover:text-ink/70" rel="noreferrer">
              Privacy
            </a>
            {' · '}
            <a href={`${REDFACE_PAY_ORIGIN}/legal/terms`} className="hover:text-ink/70" rel="noreferrer">
              Terms
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
