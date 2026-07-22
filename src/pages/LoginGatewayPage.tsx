import { Link } from 'react-router-dom';
import { Shield, Store } from 'lucide-react';
import PageSeo from '@/components/PageSeo';

export default function LoginGatewayPage() {
  return (
    <>
      <PageSeo title="Sign in" description="Sign in to Tick3t as an admin or ticket seller." path="/login" noindex />
      <div className="mx-auto max-w-2xl py-6 sm:py-10">
        <header className="text-center">
          <img src="/tick3t/wordmark.png" alt="Tick3t" className="mx-auto h-10 w-auto object-contain" />
          <h1 className="mt-6 font-display text-3xl font-extrabold tracking-tight text-ink">Sign in</h1>
          <p className="mt-2 text-sm text-ink/55">Choose how you use Tick3t.</p>
        </header>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <Link
            to="/login/sell"
            className="group flex flex-col border border-black/10 bg-white p-6 transition hover:border-brand/50"
          >
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Store className="h-5 w-5" />
            </span>
            <h2 className="mt-4 font-display text-xl font-bold text-ink">Sell tickets</h2>
            <p className="mt-2 flex-1 text-sm text-ink/55">
              Organizers and door staff — manage events, ticket types, and check-in.
            </p>
            <span className="mt-5 text-sm font-bold text-brand group-hover:underline">Continue as seller →</span>
          </Link>

          <Link
            to="/login/admin"
            className="group flex flex-col border border-black/10 bg-white p-6 transition hover:border-ink/40"
          >
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-ink/5 text-ink">
              <Shield className="h-5 w-5" />
            </span>
            <h2 className="mt-4 font-display text-xl font-bold text-ink">Admin</h2>
            <p className="mt-2 flex-1 text-sm text-ink/55">
              RedFace Pay & Entendre platform owners — approve organizers and monitor sales.
            </p>
            <span className="mt-5 text-sm font-bold text-ink group-hover:underline">Continue as admin →</span>
          </Link>
        </div>

        <p className="mt-8 text-center text-sm text-ink/45">
          Buying tickets?{' '}
          <Link to="/login/buy" className="font-semibold text-brand hover:underline">
            Sign in to your wallet
          </Link>
        </p>
      </div>
    </>
  );
}
