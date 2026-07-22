import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import PageSeo from '@/components/PageSeo';
import { buildTick3tCheckoutUrl, fetchPublicTick3tEvent } from '@/lib/tick3t/api';
import type { Tick3tPublicEvent, Tick3tTicketType } from '@/lib/tick3t/types';
import { fmtMoney } from '@/lib/format';

export default function Tick3tEventPage() {
  const { slug = '' } = useParams();
  const [sp] = useSearchParams();
  const merchantHint = sp.get('merchant_id') || undefined;
  const [event, setEvent] = useState<Tick3tPublicEvent | null>(null);
  const [types, setTypes] = useState<Tick3tTicketType[]>([]);
  const [loading, setLoading] = useState(true);
  const [qtyByType, setQtyByType] = useState<Record<string, number>>({});

  useEffect(() => {
    let on = true;
    void (async () => {
      setLoading(true);
      const result = await fetchPublicTick3tEvent(slug, merchantHint);
      if (!on) return;
      if (result) {
        setEvent(result.event);
        setTypes(result.ticketTypes);
        const defaults: Record<string, number> = {};
        for (const t of result.ticketTypes) defaults[t.id] = 1;
        setQtyByType(defaults);
      } else {
        setEvent(null);
        setTypes([]);
      }
      setLoading(false);
    })();
    return () => {
      on = false;
    };
  }, [slug, merchantHint]);

  const buy = (tt: Tick3tTicketType) => {
    if (!event) return;
    if (tt.status === 'sold_out') {
      toast.error('This ticket type is sold out');
      return;
    }
    const qty = Math.max(1, qtyByType[tt.id] || 1);
    const max = tt.max_per_customer;
    if (max != null && qty > max) {
      toast.error(`Max ${max} per customer`);
      return;
    }
    const url = buildTick3tCheckoutUrl(event.merchant_id, event, tt, qty);
    window.location.assign(url);
  };

  if (loading) {
    return <p className="text-sm text-ink/45">Loading event…</p>;
  }

  if (!event) {
    return (
      <div className="rounded-2xl border border-black/10 bg-mist p-8 text-center">
        <p className="font-semibold">Event not found</p>
        <Link to="/" className="mt-4 inline-block text-sm text-brand">
          Back to events
        </Link>
      </div>
    );
  }

  return (
    <>
      <PageSeo
        title={event.title}
        description={event.description || `Tickets for ${event.title} on Tick3t.`}
        path={`/events/${event.slug}`}
        ogImage={event.hero_image_url || event.poster_image_url || undefined}
      />
      <div className="space-y-6">
        <Link to="/" className="text-xs font-semibold text-ink/45 hover:text-ink/70">
          ← All events
        </Link>

        {(event.hero_image_url || event.poster_image_url) && (
          <img
            src={event.hero_image_url || event.poster_image_url || ''}
            alt=""
            className="max-h-72 w-full rounded-2xl object-cover"
          />
        )}

        <header className="space-y-2">
          <h1 className="text-2xl font-extrabold sm:text-3xl">{event.title}</h1>
          <p className="text-sm text-ink/55">
            {[event.venue, event.city].filter(Boolean).join(', ') || 'Venue TBA'}
          </p>
          {event.event_date && (
            <p className="text-sm text-ink/55">
              {new Date(event.event_date).toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
              {event.doors_time ? ` · Doors ${String(event.doors_time).slice(0, 5)}` : ''}
            </p>
          )}
          {event.organizer_name && (
            <p className="text-xs text-ink/40">Presented by {event.organizer_name}</p>
          )}
        </header>

        {event.description && (
          <section className="rounded-2xl border border-black/10 bg-mist p-5">
            <h2 className="text-sm font-bold">About</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink/70">{event.description}</p>
          </section>
        )}

        {event.lineup && (
          <section className="rounded-2xl border border-black/10 bg-mist p-5">
            <h2 className="text-sm font-bold">Line-up</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink/70">{event.lineup}</p>
          </section>
        )}

        <section className="space-y-3">
          <h2 className="text-sm font-bold">Tickets</h2>
          {types.length === 0 ? (
            <p className="text-sm text-ink/45">No ticket types on sale yet.</p>
          ) : (
            types.map((tt) => (
              <div
                key={tt.id}
                className="flex flex-col gap-3 rounded-2xl border border-black/10 bg-mist p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-bold">{tt.name}</p>
                  {tt.description && <p className="mt-1 text-xs text-ink/45">{tt.description}</p>}
                  <p className="mt-2 text-sm font-bold text-brand">{fmtMoney(tt.price_zar)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`qty-${tt.id}`}>
                    Quantity
                  </label>
                  <input
                    id={`qty-${tt.id}`}
                    type="number"
                    min={1}
                    max={tt.max_per_customer ?? 10}
                    value={qtyByType[tt.id] ?? 1}
                    onChange={(e) =>
                      setQtyByType((prev) => ({
                        ...prev,
                        [tt.id]: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                    className="w-16 rounded-lg border border-black/10 bg-white px-2 py-2 text-center text-sm"
                    disabled={tt.status === 'sold_out'}
                  />
                  <button
                    type="button"
                    onClick={() => buy(tt)}
                    disabled={tt.status === 'sold_out'}
                    className="min-h-[44px] rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
                  >
                    {tt.status === 'sold_out' ? 'Sold out' : 'Buy'}
                  </button>
                </div>
              </div>
            ))
          )}
        </section>

        {(event.terms || event.refund_policy || event.age_restriction) && (
          <section className="space-y-2 text-xs text-ink/40">
            {event.age_restriction && <p>Age: {event.age_restriction}</p>}
            {event.terms && <p>Terms: {event.terms}</p>}
            {event.refund_policy && <p>Refunds: {event.refund_policy}</p>}
          </section>
        )}
      </div>
    </>
  );
}
