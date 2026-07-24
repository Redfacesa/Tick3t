import { Link } from 'react-router-dom';
import { Building2, Ticket } from 'lucide-react';
import PageSeo from '@/components/PageSeo';

export default function LoginGatewayPage() {
  return (
    <>
      <PageSeo
        title="Sign in"
        description="Sell tickets, list your venue, or open your ticket wallet on Tick3t."
        path="/login"
        noindex
      />
      <div className="mx-auto max-w-lg py-6 sm:py-10">
        <header className="text-center">
          <img src="/tick3t/wordmark.png" alt="Tick3t" className="mx-auto h-10 w-auto object-contain" />
          <h1 className="mt-6 font-display text-3xl font-extrabold tracking-tight text-ink">Sign in</h1>
          <p className="mt-2 text-sm text-ink/55">Choose how you use Tick3t.</p>
        </header>

        <div className="mt-10 space-y-0">
          <Link
            to="/login/sell"
            className="group flex flex-col border border-black/10 bg-white p-6 transition hover:border-brand/50"
          >
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Ticket className="h-5 w-5" />
            </span>
            <h2 className="mt-4 font-display text-xl font-bold text-ink">Sell Tickets</h2>
            <p className="mt-2 text-sm text-ink/55">Create events and manage ticket sales.</p>
            <span className="mt-5 text-sm font-bold text-brand group-hover:underline">
              List Organizer Account →
            </span>
          </Link>

          <div className="my-5 flex items-center gap-3" aria-hidden>
            <div className="h-px flex-1 bg-black/10" />
            <div className="h-px flex-1 bg-black/10" />
          </div>

          <Link
            to="/login/venue"
            className="group flex flex-col border border-black/10 bg-white p-6 transition hover:border-brand/50"
          >
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-ink/5 text-ink">
              <Building2 className="h-5 w-5" />
            </span>
            <h2 className="mt-4 font-display text-xl font-bold text-ink">List Your Venue</h2>
            <p className="mt-2 text-sm text-ink/55">
              Advertise your venue and receive booking requests.
            </p>
            <span className="mt-5 text-sm font-bold text-brand group-hover:underline">List Venue →</span>
          </Link>

          <div className="my-5 flex items-center gap-3" aria-hidden>
            <div className="h-px flex-1 bg-black/10" />
            <div className="h-px flex-1 bg-black/10" />
          </div>

          <div className="px-1 py-2 text-center">
            <p className="text-sm text-ink/55">Already bought tickets?</p>
            <Link
              to="/login/buy"
              className="mt-2 inline-flex text-sm font-bold text-brand hover:underline"
            >
              My Tickets →
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
