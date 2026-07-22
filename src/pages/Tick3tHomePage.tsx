import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Search, Ticket } from 'lucide-react';
import PageSeo from '@/components/PageSeo';
import { fetchPublicTick3tEvents } from '@/lib/tick3t/api';
import type { Tick3tPublicEvent } from '@/lib/tick3t/types';
import { fmtMoney } from '@/lib/format';

export default function Tick3tHomePage() {
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState<Tick3tPublicEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let on = true;
    const t = window.setTimeout(() => {
      void (async () => {
        setLoading(true);
        const list = await fetchPublicTick3tEvents({ query: query || undefined });
        if (on) {
          setEvents(list);
          setLoading(false);
        }
      })();
    }, query ? 250 : 0);
    return () => {
      on = false;
      window.clearTimeout(t);
    };
  }, [query]);

  return (
    <>
      <PageSeo
        title="Tick3t"
        description="The easiest way in Africa to create, manage and sell tickets for any event."
        path="/"
      />

      <section className="relative overflow-hidden border-b border-black/8">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 70% 20%, rgba(255,75,75,0.16), transparent 55%), linear-gradient(180deg, #fff 0%, #f7f7f8 55%, #fff 100%)',
          }}
        />
        <div className="pointer-events-none absolute inset-y-1/3 left-0 right-0 opacity-70" aria-hidden>
          <div className="tick3t-streak mx-auto h-px w-[70%] max-w-3xl bg-gradient-to-r from-transparent via-brand to-transparent" />
          <div className="tick3t-streak mx-auto mt-3 h-px w-[55%] max-w-2xl bg-gradient-to-r from-transparent via-brand/60 to-transparent [animation-delay:0.6s]" />
          <div className="tick3t-streak mx-auto mt-3 h-px w-[40%] max-w-xl bg-gradient-to-r from-transparent via-brand/40 to-transparent [animation-delay:1.2s]" />
        </div>

        <div className="relative mx-auto flex min-h-[calc(100vh-4.5rem)] max-w-6xl flex-col items-center justify-center px-4 py-16 text-center sm:px-6 sm:py-20">
          <img
            src="/tick3t/lockup.png"
            alt="Tick3t — Buy tickets online"
            className="tick3t-rise h-auto w-full max-w-[280px] object-contain sm:max-w-[360px]"
            onError={(e) => {
              e.currentTarget.src = '/tick3t/wordmark.png';
            }}
          />
          <p className="tick3t-rise-delay mt-8 max-w-md font-display text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
            Tickets that move as fast as the night.
          </p>
          <p className="tick3t-rise-delay-2 mt-3 max-w-lg text-sm text-ink/55 sm:text-base">
            Create, manage and sell for any event across Africa — paid securely through RedFace Pay.
          </p>
          <div className="tick3t-rise-delay-2 mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href="#events"
              className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white transition hover:bg-brand/90"
            >
              Browse events
              <ArrowRight className="h-4 w-4" />
            </a>
            <Link
              to="/login/sell"
              className="inline-flex min-h-[48px] items-center gap-2 rounded-xl border border-ink/15 bg-white px-5 py-3 text-sm font-bold text-ink transition hover:border-ink/30"
            >
              <Ticket className="h-4 w-4 text-brand" />
              Sell tickets
            </Link>
          </div>
        </div>
      </section>

      <section id="events" className="scroll-mt-24 bg-white py-14 sm:py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="font-display text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
                Live events
              </h2>
              <p className="mt-1 text-sm text-ink/55">Find a night out. Pay once. Show your QR at the door.</p>
            </div>
            <div className="relative w-full max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/35" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search events, venues, cities…"
                className="w-full rounded-xl border border-black/10 bg-mist py-3 pl-10 pr-3 text-sm text-ink outline-none placeholder:text-ink/35 focus:border-brand/50"
              />
            </div>
          </div>

          <div className="mt-8">
            {loading ? (
              <p className="text-sm text-ink/45">Loading events…</p>
            ) : events.length === 0 ? (
              <div className="border border-dashed border-black/15 bg-mist px-6 py-12 text-center">
                <p className="font-semibold text-ink">No events on sale yet</p>
                <p className="mt-2 text-sm text-ink/45">Be first — open your organizer desk and publish one.</p>
                <Link
                  to="/login/sell"
                  className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white"
                >
                  Start selling
                </Link>
              </div>
            ) : (
              <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {events.map((ev) => (
                  <li key={ev.id} className="tick3t-fade">
                    <Link
                      to={`/events/${encodeURIComponent(ev.slug)}`}
                      className="group block overflow-hidden border border-black/10 bg-white transition hover:border-brand/40"
                    >
                      {ev.hero_image_url || ev.poster_image_url ? (
                        <img
                          src={ev.hero_image_url || ev.poster_image_url || ''}
                          alt=""
                          className="h-44 w-full object-cover transition duration-500 group-hover:scale-[1.03]"
                        />
                      ) : (
                        <div className="flex h-44 items-center justify-center bg-mist">
                          <img src="/tick3t/icon.png" alt="" className="h-14 w-auto object-contain opacity-80" />
                        </div>
                      )}
                      <div className="space-y-1 p-4">
                        <p className="font-bold text-ink">{ev.title}</p>
                        <p className="text-xs text-ink/45">
                          {[ev.venue, ev.city].filter(Boolean).join(', ') || 'Venue TBA'}
                        </p>
                        {ev.event_date && (
                          <p className="text-xs text-ink/45">
                            {new Date(ev.event_date).toLocaleDateString(undefined, {
                              weekday: 'short',
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })}
                          </p>
                        )}
                        <div className="flex items-center justify-between pt-2">
                          <span className="text-xs text-ink/40">{ev.organizer_name}</span>
                          <span className="text-sm font-bold text-brand">
                            {ev.from_price_zar != null ? `From ${fmtMoney(ev.from_price_zar)}` : 'Tickets'}
                          </span>
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
