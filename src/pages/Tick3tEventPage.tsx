import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import PageSeo from '@/components/PageSeo';
import {
  buildTick3tCheckoutUrl,
  fetchPublicTick3tEvent,
  isTicketTypeOnSale,
  validateTick3tPromo,
} from '@/lib/tick3t/api';
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
  const [promoInput, setPromoInput] = useState('');
  const [promoBusy, setPromoBusy] = useState(false);
  const [appliedPromo, setAppliedPromo] = useState<{
    code: string;
    discountZar: number;
    discountType?: string;
    discountValue?: number;
  } | null>(null);

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

  const applyPromo = async () => {
    if (!event) return;
    const code = promoInput.trim().toUpperCase();
    if (!code) {
      toast.error('Enter a promo code');
      return;
    }
    // Quote against a sample subtotal so % / fixed codes validate; buy path recomputes.
    const sample = types.find((t) => isTicketTypeOnSale(t));
    const sampleSubtotal = sample ? Number(sample.price_zar) || 0 : 0;
    setPromoBusy(true);
    const quote = await validateTick3tPromo({
      merchantId: event.merchant_id,
      code,
      eventId: event.id,
      subtotalZar: sampleSubtotal || 100,
    });
    setPromoBusy(false);
    if (!quote.ok) {
      setAppliedPromo(null);
      toast.error(quote.message || 'Invalid promo');
      return;
    }
    setAppliedPromo({
      code: String(quote.code || code),
      discountZar: Number(quote.discount_zar) || 0,
      discountType: quote.discount_type,
      discountValue: Number(quote.discount_value) || undefined,
    });
    toast.success(`Promo ${quote.code} applied`);
  };

  const clearPromo = () => {
    setAppliedPromo(null);
    setPromoInput('');
  };

  const discountedAmount = (unit: number, qty: number) => {
    const subtotal = unit * qty;
    if (!appliedPromo) return { amount: subtotal, discount: 0, subtotal };
    let discount = 0;
    if (appliedPromo.discountType === 'percent' && appliedPromo.discountValue != null) {
      discount = Math.round(subtotal * (appliedPromo.discountValue / 100) * 100) / 100;
    } else if (appliedPromo.discountType === 'fixed' && appliedPromo.discountValue != null) {
      discount = Math.min(subtotal, appliedPromo.discountValue);
    } else {
      discount = Math.min(subtotal, appliedPromo.discountZar);
    }
    return {
      subtotal,
      discount,
      amount: Math.max(0, Math.round((subtotal - discount) * 100) / 100),
    };
  };

  const promoHint = useMemo(() => {
    if (!appliedPromo) return null;
    if (appliedPromo.discountType === 'percent' && appliedPromo.discountValue != null) {
      return `${appliedPromo.code} · ${appliedPromo.discountValue}% off`;
    }
    if (appliedPromo.discountType === 'fixed' && appliedPromo.discountValue != null) {
      return `${appliedPromo.code} · ${fmtMoney(appliedPromo.discountValue)} off`;
    }
    return appliedPromo.code;
  }, [appliedPromo]);

  const buy = (tt: Tick3tTicketType) => {
    if (!event) return;
    if (!isTicketTypeOnSale(tt)) {
      toast.error(
        tt.status === 'sold_out'
          ? 'This ticket type is sold out'
          : 'This ticket is not on sale right now',
      );
      return;
    }
    const qty = Math.max(1, qtyByType[tt.id] || 1);
    const max = tt.max_per_customer;
    if (max != null && qty > max) {
      toast.error(`Max ${max} per customer`);
      return;
    }
    const remaining = tt.capacity != null ? tt.capacity - (tt.sold_count ?? 0) : null;
    if (remaining != null && qty > remaining) {
      toast.error(`Only ${remaining} left`);
      return;
    }
    const priced = discountedAmount(Number(tt.price_zar) || 0, qty);
    if (priced.amount <= 0) {
      toast.error('Amount after discount must be greater than zero');
      return;
    }
    const url = buildTick3tCheckoutUrl(
      event.merchant_id,
      event,
      tt,
      qty,
      undefined,
      appliedPromo
        ? {
            code: appliedPromo.code,
            amountZar: priced.amount,
            discountZar: priced.discount,
          }
        : undefined,
    );
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

        {Array.isArray(event.gallery) &&
          event.gallery.filter((u): u is string => typeof u === 'string').length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-bold">Gallery</h2>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
                {(event.gallery as unknown[])
                  .filter((u): u is string => typeof u === 'string' && u.length > 0)
                  .slice(0, 5)
                  .map((url) => (
                    <li key={url} className="overflow-hidden rounded-xl border border-black/10">
                      <img src={url} alt="" className="aspect-square w-full object-cover" />
                    </li>
                  ))}
              </ul>
            </section>
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

        <section className="rounded-2xl border border-black/10 bg-mist p-4">
          <h2 className="text-sm font-bold">Promo code</h2>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              className="min-h-[44px] flex-1 rounded-xl border border-black/10 bg-white px-3 text-sm uppercase outline-none focus:border-brand/50"
              placeholder="Enter code"
              value={promoInput}
              onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
              disabled={!!appliedPromo}
            />
            {appliedPromo ? (
              <button
                type="button"
                onClick={clearPromo}
                className="min-h-[44px] rounded-xl border border-black/15 px-4 text-sm font-bold"
              >
                Remove
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void applyPromo()}
                disabled={promoBusy}
                className="min-h-[44px] rounded-xl bg-brand px-4 text-sm font-bold text-white disabled:opacity-50"
              >
                {promoBusy ? 'Checking…' : 'Apply'}
              </button>
            )}
          </div>
          {promoHint && <p className="mt-2 text-xs font-semibold text-brand">{promoHint}</p>}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-bold">Tickets</h2>
          {types.length === 0 ? (
            <p className="text-sm text-ink/45">No ticket types on sale yet.</p>
          ) : (
            types.map((tt) => {
              const onSale = isTicketTypeOnSale(tt);
              const qty = qtyByType[tt.id] ?? 1;
              const priced = discountedAmount(Number(tt.price_zar) || 0, qty);
              return (
                <div
                  key={tt.id}
                  className="flex flex-col gap-3 rounded-2xl border border-black/10 bg-mist p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-bold">{tt.name}</p>
                    {tt.description && <p className="mt-1 text-xs text-ink/45">{tt.description}</p>}
                    <p className="mt-2 text-sm font-bold text-brand">
                      {appliedPromo && priced.discount > 0 ? (
                        <>
                          <span className="mr-2 text-ink/35 line-through">{fmtMoney(priced.subtotal)}</span>
                          {fmtMoney(priced.amount)}
                        </>
                      ) : (
                        fmtMoney(tt.price_zar)
                      )}
                    </p>
                    {!onSale && (
                      <p className="mt-1 text-xs text-ink/40">
                        {tt.status === 'sold_out'
                          ? 'Sold out'
                          : tt.sale_opens_at && new Date(tt.sale_opens_at) > new Date()
                            ? `Opens ${new Date(tt.sale_opens_at).toLocaleString()}`
                            : 'Not on sale'}
                      </p>
                    )}
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
                      disabled={!onSale}
                    />
                    <button
                      type="button"
                      onClick={() => buy(tt)}
                      disabled={!onSale}
                      className="min-h-[44px] rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
                    >
                      {!onSale ? (tt.status === 'sold_out' ? 'Sold out' : 'Unavailable') : 'Buy'}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </section>

        {(event.terms ||
          event.refund_policy ||
          event.age_restriction ||
          event.maps_url ||
          event.contact_email ||
          event.contact_phone ||
          event.website_url ||
          event.instagram_url ||
          event.facebook_url) && (
          <section className="space-y-4 rounded-2xl border border-black/10 bg-mist p-5">
            <h2 className="text-sm font-bold">Details</h2>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
              {event.maps_url && (
                <a href={event.maps_url} target="_blank" rel="noreferrer" className="font-semibold text-brand">
                  Open map
                </a>
              )}
              {event.website_url && (
                <a href={event.website_url} target="_blank" rel="noreferrer" className="font-semibold text-brand">
                  Website
                </a>
              )}
              {event.instagram_url && (
                <a href={event.instagram_url} target="_blank" rel="noreferrer" className="font-semibold text-brand">
                  Instagram
                </a>
              )}
              {event.facebook_url && (
                <a href={event.facebook_url} target="_blank" rel="noreferrer" className="font-semibold text-brand">
                  Facebook
                </a>
              )}
            </div>
            <div className="space-y-1 text-sm text-ink/60">
              {event.contact_email && (
                <p>
                  Email{' '}
                  <a className="font-semibold text-brand" href={`mailto:${event.contact_email}`}>
                    {event.contact_email}
                  </a>
                </p>
              )}
              {event.contact_phone && (
                <p>
                  Phone{' '}
                  <a className="font-semibold text-brand" href={`tel:${event.contact_phone}`}>
                    {event.contact_phone}
                  </a>
                </p>
              )}
            </div>
            <div className="space-y-2 border-t border-black/10 pt-3 text-xs text-ink/40">
              {event.age_restriction && <p>Age: {event.age_restriction}</p>}
              {event.terms && <p className="whitespace-pre-wrap">Terms: {event.terms}</p>}
              {event.refund_policy && <p className="whitespace-pre-wrap">Refunds: {event.refund_policy}</p>}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
