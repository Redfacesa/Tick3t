import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
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
        description="Browse and buy tickets for events across Africa. Create, manage, and sell with Tick3t."
        path="/"
      />
      <div className="space-y-6">
        <header className="space-y-3">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Find your next event</h1>
          <p className="max-w-xl text-sm text-white/55">
            Browse live events, pick a ticket type, and pay securely through RedFace Pay.
          </p>
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search events, venues, cities…"
              className="w-full rounded-xl border border-white/12 bg-[#111] py-3 pl-10 pr-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-[#FF4B4B]/50"
            />
          </div>
        </header>

        {loading ? (
          <p className="text-sm text-white/45">Loading events…</p>
        ) : events.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-[#111] p-8 text-center">
            <p className="font-semibold text-white">No events on sale yet</p>
            <p className="mt-2 text-sm text-white/45">Check back soon, or register as an organizer to host one.</p>
            <Link
              to="/organizer/register"
              className="mt-4 inline-flex min-h-[44px] items-center rounded-xl bg-[#FF4B4B] px-4 py-2 text-sm font-bold text-white"
            >
              Become an organizer
            </Link>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {events.map((ev) => (
              <li key={ev.id}>
                <Link
                  to={`/events/${encodeURIComponent(ev.slug)}`}
                  className="block overflow-hidden rounded-2xl border border-white/10 bg-[#111] transition hover:border-white/20"
                >
                  {ev.hero_image_url || ev.poster_image_url ? (
                    <img
                      src={ev.hero_image_url || ev.poster_image_url || ''}
                      alt=""
                      className="h-40 w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-40 items-center justify-center bg-[#0a0a0a] text-sm text-white/30">
                      Tick3t
                    </div>
                  )}
                  <div className="space-y-1 p-4">
                    <p className="font-bold text-white">{ev.title}</p>
                    <p className="text-xs text-white/45">
                      {[ev.venue, ev.city].filter(Boolean).join(', ') || 'Venue TBA'}
                    </p>
                    {ev.event_date && (
                      <p className="text-xs text-white/45">
                        {new Date(ev.event_date).toLocaleDateString(undefined, {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </p>
                    )}
                    <div className="flex items-center justify-between pt-2">
                      <span className="text-xs text-white/40">{ev.organizer_name}</span>
                      <span className="text-sm font-bold text-[#FF4B4B]">
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
    </>
  );
}
