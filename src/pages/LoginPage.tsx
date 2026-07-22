import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import PageSeo from '@/components/PageSeo';
import { useAuth } from '@/contexts/AuthContext';
import { checkTick3tIsAdmin } from '@/lib/tick3t/api';
import { buildPayEcosystemLoginUrl, stripSsoParamsFromPath } from '@/lib/sso';

export type LoginRole = 'admin' | 'sell' | 'buy';

const ROLE_COPY: Record<
  LoginRole,
  { title: string; description: string; defaultReturn: string; path: string }
> = {
  admin: {
    title: 'Admin sign in',
    description: 'Platform access for RedFace Pay and Entendre co-owners.',
    defaultReturn: '/admin',
    path: '/login/admin',
  },
  sell: {
    title: 'Seller sign in',
    description: 'Create events, sell tickets, and run door check-in.',
    defaultReturn: '/organizer',
    path: '/login/sell',
  },
  buy: {
    title: 'Ticket wallet',
    description: 'Sign in to view tickets bought with your email.',
    defaultReturn: '/tickets',
    path: '/login/buy',
  },
};

function safeReturnPath(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  try {
    if (raw.startsWith('/') && !raw.startsWith('//')) {
      return stripSsoParamsFromPath(raw);
    }
    const u = new URL(raw);
    if (typeof window !== 'undefined' && u.origin === window.location.origin) {
      return stripSsoParamsFromPath(`${u.pathname}${u.search}${u.hash}`);
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function roleHome(role: LoginRole, returnPath: string): string {
  if (role === 'admin') return returnPath.startsWith('/admin') ? returnPath : '/admin';
  if (role === 'sell') {
    return returnPath.startsWith('/organizer') || returnPath.startsWith('/staff') ? returnPath : '/organizer';
  }
  return returnPath.startsWith('/tickets') ? returnPath : '/tickets';
}

export default function LoginPage({ role }: { role: LoginRole }) {
  const copy = ROLE_COPY[role];
  const { user, loading, configError } = useAuth();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const [routing, setRouting] = useState(false);
  const returnPath = safeReturnPath(sp.get('return_url'), copy.defaultReturn);
  const dest = roleHome(role, returnPath);

  const payLoginUrl = useMemo(() => buildPayEcosystemLoginUrl(dest), [dest]);

  useEffect(() => {
    if (loading || !user || routing) return;
    let on = true;
    setRouting(true);

    void (async () => {
      if (role === 'admin') {
        const allowed = await checkTick3tIsAdmin(user.email);
        if (!on) return;
        if (!allowed) {
          toast.error('This account is not a Tick3t platform admin.');
          navigate('/', { replace: true });
          return;
        }
      }
      navigate(dest, { replace: true });
    })();

    return () => {
      on = false;
    };
  }, [loading, user, navigate, dest, role, routing]);

  return (
    <>
      <PageSeo title={copy.title} description={copy.description} path={copy.path} noindex />
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 py-4">
        <header className="w-full text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand">
            {role === 'admin' ? 'Platform' : role === 'sell' ? 'Organizer' : 'Guest'}
          </p>
          <h1 className="mt-2 font-display text-2xl font-extrabold text-ink">{copy.title}</h1>
          <p className="mt-2 text-sm text-ink/55">{copy.description}</p>
        </header>

        {configError && (
          <div className="w-full border border-amber-500/40 bg-amber-50 px-4 py-3 text-left text-sm text-amber-950">
            <p className="font-bold">Deploy config missing</p>
            <p className="mt-1">{configError}</p>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-ink/45">Checking session…</p>
        ) : (
          <>
            <a
              href={payLoginUrl}
              className="inline-flex min-h-[48px] w-full items-center justify-center rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white"
            >
              Continue with RedFace Pay
            </a>
            <p className="text-center text-xs text-ink/45">
              Sign in on RedFace Pay, then you return here automatically.
            </p>
          </>
        )}

        <div className="flex flex-col items-center gap-2 text-sm text-ink/45">
          <Link to="/login" className="hover:text-ink/70">
            ← Choose a different login
          </Link>
          <Link to="/" className="hover:text-ink/70">
            Back to home
          </Link>
        </div>
      </div>
    </>
  );
}
