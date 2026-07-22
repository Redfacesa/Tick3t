import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { SignIn } from '@clerk/react';
import PageSeo from '@/components/PageSeo';
import { useAuth } from '@/contexts/AuthContext';
import { isClerkEnabled } from '@/lib/clerkEnabled';
import { REDFACE_PAY_ORIGIN } from '@/lib/company';

function safeReturnPath(raw: string | null): string {
  if (!raw) return '/';
  try {
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
    const u = new URL(raw);
    if (typeof window !== 'undefined' && u.origin === window.location.origin) {
      return u.pathname + u.search + u.hash;
    }
  } catch {
    /* ignore */
  }
  return '/';
}

export default function LoginPage() {
  const { user, loading } = useAuth();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const returnPath = safeReturnPath(sp.get('return_url'));

  useEffect(() => {
    if (!loading && user) navigate(returnPath, { replace: true });
  }, [loading, user, navigate, returnPath]);

  return (
    <>
      <PageSeo title="Sign in" description="Sign in to Tick3t." path="/login" noindex />
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 py-8">
        <header className="text-center">
          <h1 className="text-2xl font-extrabold">Sign in</h1>
          <p className="mt-2 text-sm text-white/55">Use your RedFace account to buy tickets or manage events.</p>
        </header>

        {isClerkEnabled() ? (
          <SignIn
            routing="hash"
            forceRedirectUrl={returnPath}
            signUpForceRedirectUrl={returnPath}
            appearance={{
              elements: {
                rootBox: 'w-full',
                card: 'bg-[#111] border border-white/10 shadow-none',
              },
            }}
          />
        ) : (
          <div className="w-full rounded-2xl border border-white/10 bg-[#111] p-6 text-center">
            <p className="text-sm text-white/55">
              Clerk is not configured for this deploy. Sign in on RedFace Pay, then return here.
            </p>
            <a
              href={`${REDFACE_PAY_ORIGIN}/login?return_url=${encodeURIComponent(
                typeof window !== 'undefined' ? window.location.origin + returnPath : returnPath,
              )}&ecosystem_from=tick3t`}
              className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-[#FF4B4B] px-5 py-2 text-sm font-bold text-white"
            >
              Continue on RedFace Pay
            </a>
          </div>
        )}

        <Link to="/" className="text-sm text-white/45 hover:text-white/70">
          ← Back to events
        </Link>
      </div>
    </>
  );
}
