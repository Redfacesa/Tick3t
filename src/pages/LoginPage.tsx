import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { SignIn } from '@clerk/react';
import { toast } from 'sonner';
import PageSeo from '@/components/PageSeo';
import { useAuth } from '@/contexts/AuthContext';
import { isClerkEnabled } from '@/lib/clerkEnabled';
import { checkTick3tIsAdmin } from '@/lib/tick3t/api';
import { absoluteTick3tReturnUrl, buildPayEcosystemLoginUrl } from '@/lib/sso';

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
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
    const u = new URL(raw);
    if (typeof window !== 'undefined' && u.origin === window.location.origin) {
      return u.pathname + u.search + u.hash;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

export default function LoginPage({ role }: { role: LoginRole }) {
  const copy = ROLE_COPY[role];
  const { user, loading } = useAuth();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const [routing, setRouting] = useState(false);
  const returnPath = safeReturnPath(sp.get('return_url'), copy.defaultReturn);

  const payLoginUrl = useMemo(() => {
    const dest =
      role === 'admin'
        ? returnPath.startsWith('/admin')
          ? returnPath
          : '/admin'
        : role === 'sell'
          ? returnPath.startsWith('/organizer') || returnPath.startsWith('/staff')
            ? returnPath
            : '/organizer'
          : returnPath.startsWith('/tickets')
            ? returnPath
            : '/tickets';
    return buildPayEcosystemLoginUrl(dest);
  }, [role, returnPath]);

  const clerkRedirectUrl = useMemo(() => absoluteTick3tReturnUrl(returnPath), [returnPath]);

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
        navigate(returnPath.startsWith('/admin') ? returnPath : '/admin', { replace: true });
        return;
      }

      if (role === 'sell') {
        navigate(
          returnPath.startsWith('/organizer') || returnPath.startsWith('/staff') ? returnPath : '/organizer',
          { replace: true },
        );
        return;
      }

      navigate(returnPath.startsWith('/tickets') ? returnPath : '/tickets', { replace: true });
    })();

    return () => {
      on = false;
    };
  }, [loading, user, navigate, returnPath, role, routing]);

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

        {/* Primary: RedFace Pay ecosystem SSO (approved absolute return_url). */}
        <a
          href={payLoginUrl}
          className="inline-flex min-h-[48px] w-full items-center justify-center rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white"
        >
          Continue with RedFace Pay
        </a>
        <p className="text-center text-xs text-ink/45">
          Sign in on RedFace Pay, then you return here automatically.
        </p>

        {isClerkEnabled() && (
          <div className="w-full border-t border-black/10 pt-6">
            <p className="mb-3 text-center text-xs font-semibold uppercase tracking-wide text-ink/40">
              Or use Clerk on this site
            </p>
            <SignIn
              routing="hash"
              forceRedirectUrl={clerkRedirectUrl}
              signUpForceRedirectUrl={absoluteTick3tReturnUrl(
                role === 'admin' ? '/admin' : role === 'sell' ? '/organizer' : '/tickets',
              )}
              appearance={{
                elements: {
                  rootBox: 'w-full',
                  card: 'bg-white border border-black/10 shadow-none',
                },
              }}
            />
          </div>
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
