import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import PageSeo from '@/components/PageSeo';
import { useAuth } from '@/contexts/AuthContext';
import { downloadFile } from '@/lib/download';
import { fmtMoney } from '@/lib/format';
import {
  decideTick3tRefund,
  fetchTick3tEvents,
  fetchTick3tOrganizerMe,
  fetchTick3tPromos,
  fetchTick3tRefunds,
  fetchTick3tStaff,
  fetchTick3tStats,
  fetchTick3tTicketTypes,
  fetchTick3tTickets,
  organizerStatusLabel,
  upsertTick3tEvent,
  upsertTick3tPromo,
  upsertTick3tStaff,
  upsertTick3tTicketType,
} from '@/lib/tick3t/api';
import type {
  Tick3tEvent,
  Tick3tOrganizer,
  Tick3tPromoCode,
  Tick3tRefundRequest,
  Tick3tStaff,
  Tick3tTicket,
  Tick3tTicketType,
} from '@/lib/tick3t/types';
import { REDFACE_PAY_ORIGIN, SITE_URL } from '@/lib/company';

const inputClass =
  'w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-brand/50';

type Tab = 'overview' | 'events' | 'tickets' | 'staff' | 'promos' | 'refunds' | 'finance' | 'profile';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'events', label: 'Events' },
  { id: 'tickets', label: 'Ticket types' },
  { id: 'staff', label: 'Staff' },
  { id: 'promos', label: 'Promos' },
  { id: 'refunds', label: 'Refunds' },
  { id: 'finance', label: 'Finance' },
  { id: 'profile', label: 'Profile' },
];

const emptyEventForm = {
  id: '',
  title: '',
  slug: '',
  venue: '',
  city: '',
  event_date: '',
  doors_time: '',
  end_time: '',
  lineup: '',
  description: '',
  category: '',
  capacity: '',
  maps_url: '',
  age_restriction: '',
  terms: '',
  refund_policy: '',
  contact_email: '',
  contact_phone: '',
  website_url: '',
  instagram_url: '',
  facebook_url: '',
  hero_image_url: '',
  poster_image_url: '',
  status: 'draft' as string,
};

export default function Tick3tOrganizerDashboard() {
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || (location.pathname.includes('/events') ? 'events' : 'overview');

  const [organizer, setOrganizer] = useState<Tick3tOrganizer | null>(null);
  const [events, setEvents] = useState<Tick3tEvent[]>([]);
  const [tickets, setTickets] = useState<Tick3tTicket[]>([]);
  const [ticketTypes, setTicketTypes] = useState<Tick3tTicketType[]>([]);
  const [staff, setStaff] = useState<Tick3tStaff[]>([]);
  const [promos, setPromos] = useState<Tick3tPromoCode[]>([]);
  const [refunds, setRefunds] = useState<Tick3tRefundRequest[]>([]);
  const [stats, setStats] = useState<{
    total_tickets: number;
    revenue_zar: number;
    valid: number;
    checked_in: number;
    refunded?: number;
    refunded_zar?: number;
    net_revenue_zar?: number;
    events_live?: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [eventForm, setEventForm] = useState(emptyEventForm);
  const [ticketForm, setTicketForm] = useState({
    id: '',
    event_id: '',
    name: 'General',
    description: '',
    price_zar: '',
    capacity: '',
    sale_opens_at: '',
    sale_closes_at: '',
    max_per_customer: '',
    status: 'on_sale',
  });
  const [staffForm, setStaffForm] = useState({
    email: '',
    display_name: '',
    role: 'scanner',
    event_id: '',
  });
  const [promoForm, setPromoForm] = useState({
    code: '',
    discount_type: 'percent' as 'percent' | 'fixed',
    discount_value: '',
    event_id: '',
    max_redemptions: '',
  });

  const setTab = (id: Tab) => {
    const next = new URLSearchParams(sp);
    next.set('tab', id);
    setSp(next, { replace: true });
  };

  const reload = useCallback(async () => {
    const me = await fetchTick3tOrganizerMe();
    setOrganizer(me);
    if (me?.merchant_id && me.status === 'approved') {
      const [ev, tk, st, sf, pr, rf] = await Promise.all([
        fetchTick3tEvents(me.merchant_id),
        fetchTick3tTickets(me.merchant_id),
        fetchTick3tStats(me.merchant_id),
        fetchTick3tStaff(me.merchant_id),
        fetchTick3tPromos(me.merchant_id),
        fetchTick3tRefunds(me.merchant_id),
      ]);
      setEvents(ev);
      setTickets(tk);
      setStats(st);
      setStaff(sf);
      setPromos(pr);
      setRefunds(rf);
      const selectedEventId = ticketForm.event_id || ev[0]?.id || '';
      if (selectedEventId) {
        setTicketForm((f) => ({ ...f, event_id: f.event_id || selectedEventId }));
        const types = await fetchTick3tTicketTypes(me.merchant_id, selectedEventId);
        setTicketTypes(types);
      } else {
        setTicketTypes([]);
      }
    } else {
      setEvents([]);
      setTickets([]);
      setStats(null);
      setStaff([]);
      setPromos([]);
      setRefunds([]);
      setTicketTypes([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit ticketForm to avoid reload loops
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    let on = true;
    void (async () => {
      setLoading(true);
      await reload();
      if (on) setLoading(false);
    })();
    return () => {
      on = false;
    };
  }, [user, authLoading, reload]);

  const loadTypesForEvent = async (eventId: string) => {
    if (!organizer?.merchant_id || !eventId) return;
    const types = await fetchTick3tTicketTypes(organizer.merchant_id, eventId);
    setTicketTypes(types);
    setTicketForm((f) => ({ ...f, event_id: eventId }));
  };

  const editEvent = (ev: Tick3tEvent) => {
    setEventForm({
      id: ev.id,
      title: ev.title,
      slug: ev.slug,
      venue: ev.venue || '',
      city: ev.city || '',
      event_date: ev.event_date || '',
      doors_time: ev.doors_time ? String(ev.doors_time).slice(0, 5) : '',
      end_time: ev.end_time ? String(ev.end_time).slice(0, 5) : '',
      lineup: ev.lineup || '',
      description: ev.description || '',
      category: ev.category || '',
      capacity: ev.capacity != null ? String(ev.capacity) : '',
      maps_url: ev.maps_url || '',
      age_restriction: ev.age_restriction || '',
      terms: ev.terms || '',
      refund_policy: ev.refund_policy || '',
      contact_email: ev.contact_email || '',
      contact_phone: ev.contact_phone || '',
      website_url: ev.website_url || '',
      instagram_url: ev.instagram_url || '',
      facebook_url: ev.facebook_url || '',
      hero_image_url: ev.hero_image_url || '',
      poster_image_url: ev.poster_image_url || '',
      status: ev.status,
    });
    setTab('events');
  };

  const saveEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!organizer?.merchant_id) return;
    const slug =
      eventForm.slug.trim() ||
      eventForm.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    if (!eventForm.title.trim() || !slug) {
      toast.error('Title is required');
      return;
    }
    setSaving(true);
    const { eventId, error } = await upsertTick3tEvent(organizer.merchant_id, {
      ...(eventForm.id ? { id: eventForm.id } : {}),
      title: eventForm.title.trim(),
      slug,
      venue: eventForm.venue || null,
      city: eventForm.city || null,
      event_date: eventForm.event_date || null,
      doors_time: eventForm.doors_time || null,
      end_time: eventForm.end_time || null,
      lineup: eventForm.lineup || null,
      description: eventForm.description || null,
      category: eventForm.category || null,
      capacity: eventForm.capacity ? Number(eventForm.capacity) : null,
      maps_url: eventForm.maps_url || null,
      age_restriction: eventForm.age_restriction || null,
      terms: eventForm.terms || null,
      refund_policy: eventForm.refund_policy || null,
      contact_email: eventForm.contact_email || null,
      contact_phone: eventForm.contact_phone || null,
      website_url: eventForm.website_url || null,
      instagram_url: eventForm.instagram_url || null,
      facebook_url: eventForm.facebook_url || null,
      hero_image_url: eventForm.hero_image_url || null,
      poster_image_url: eventForm.poster_image_url || null,
      status: eventForm.status as Tick3tEvent['status'],
    } as Partial<Tick3tEvent> & { slug: string; title: string });
    setSaving(false);
    if (!eventId) {
      toast.error(error || 'Could not save event');
      return;
    }
    toast.success(eventForm.id ? 'Event updated' : 'Event created');
    setEventForm({ ...emptyEventForm, status: 'draft' });
    setTicketForm((f) => ({ ...f, event_id: eventId }));
    await reload();
  };

  const eventPublicUrl = (ev: Pick<Tick3tEvent, 'slug' | 'merchant_id'>) =>
    `${SITE_URL}/events/${ev.slug}?merchant_id=${encodeURIComponent(ev.merchant_id)}`;

  const copyEventLink = async (ev: Tick3tEvent) => {
    const url = eventPublicUrl(ev);
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Public link copied');
    } catch {
      toast.message(url);
    }
  };

  const publishEvent = async (ev: Tick3tEvent, status: Tick3tEvent['status']) => {
    if (!organizer?.merchant_id) return;

    if (status === 'on_sale' || status === 'published') {
      const missing: string[] = [];
      if (!ev.title?.trim()) missing.push('title');
      if (!ev.slug?.trim()) missing.push('slug');
      if (!ev.event_date) missing.push('event date');
      if (!ev.venue?.trim() && !ev.city?.trim()) missing.push('venue or city');
      const types = await fetchTick3tTicketTypes(organizer.merchant_id, ev.id);
      const sellable = types.some((t) => t.status === 'on_sale');
      if (!sellable) missing.push('at least one on-sale ticket type');
      if (missing.length) {
        toast.error(`Before going live: add ${missing.join(', ')}`);
        if (!sellable) {
          setTicketForm((f) => ({ ...f, event_id: ev.id }));
          setTab('tickets');
        } else {
          editEvent(ev);
          setTab('events');
        }
        return;
      }
    }

    const { eventId, error } = await upsertTick3tEvent(organizer.merchant_id, {
      id: ev.id,
      slug: ev.slug,
      title: ev.title,
      status,
    });
    if (!eventId) {
      toast.error(error || 'Could not update status');
      return;
    }
    toast.success(
      status === 'on_sale'
        ? 'Event is live and on sale'
        : status === 'published'
          ? 'Event listed (not selling yet)'
          : `Event marked ${status.replace('_', ' ')}`,
    );
    await reload();
  };

  const saveTicketType = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!organizer?.merchant_id || !ticketForm.event_id) return;
    const price = Number(ticketForm.price_zar);
    if (!ticketForm.name.trim() || Number.isNaN(price) || price < 0) {
      toast.error('Name and price required');
      return;
    }
    const { ticketTypeId, error } = await upsertTick3tTicketType(
      organizer.merchant_id,
      ticketForm.event_id,
      {
        ...(ticketForm.id ? { id: ticketForm.id } : {}),
        name: ticketForm.name.trim(),
        description: ticketForm.description || null,
        price_zar: price,
        capacity: ticketForm.capacity ? Number(ticketForm.capacity) : null,
        sale_opens_at: ticketForm.sale_opens_at || null,
        sale_closes_at: ticketForm.sale_closes_at || null,
        max_per_customer: ticketForm.max_per_customer ? Number(ticketForm.max_per_customer) : null,
        status: ticketForm.status,
      },
    );
    if (!ticketTypeId) {
      toast.error(error || 'Could not save ticket type');
      return;
    }
    toast.success('Ticket type saved');
    setTicketForm((f) => ({
      ...f,
      id: '',
      name: 'General',
      description: '',
      price_zar: '',
      capacity: '',
      sale_opens_at: '',
      sale_closes_at: '',
      max_per_customer: '',
      status: 'on_sale',
    }));
    await loadTypesForEvent(ticketForm.event_id);
  };

  const saveStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!organizer?.merchant_id) return;
    const { staffId, error } = await upsertTick3tStaff(organizer.merchant_id, {
      email: staffForm.email.trim(),
      display_name: staffForm.display_name || null,
      role: staffForm.role as import('@/lib/tick3t/types').Tick3tStaffRole,
      event_id: staffForm.event_id || null,
      status: 'invited',
    });
    if (!staffId) {
      toast.error(error || 'Could not invite staff');
      return;
    }
    toast.success('Staff invited — they can scan after signing in');
    setStaffForm({ email: '', display_name: '', role: 'scanner', event_id: '' });
    await reload();
  };

  const savePromo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!organizer?.merchant_id) return;
    const value = Number(promoForm.discount_value);
    if (!promoForm.code.trim() || Number.isNaN(value) || value <= 0) {
      toast.error('Code and discount required');
      return;
    }
    const { promoId, error } = await upsertTick3tPromo(organizer.merchant_id, {
      code: promoForm.code.trim(),
      discount_type: promoForm.discount_type,
      discount_value: value,
      event_id: promoForm.event_id || null,
      max_redemptions: promoForm.max_redemptions ? Number(promoForm.max_redemptions) : null,
      active: true,
    });
    if (!promoId) {
      toast.error(error || 'Could not save promo');
      return;
    }
    toast.success('Promo code saved');
    setPromoForm({ code: '', discount_type: 'percent', discount_value: '', event_id: '', max_redemptions: '' });
    await reload();
  };

  const exportCsv = () => {
    const header = 'code,guest,event,status,amount\n';
    const body = tickets
      .map(
        (t) =>
          `${t.ticket_code},"${(t.buyer_name || t.buyer_email).replace(/"/g, '""')}",${t.event_name},${t.status},${t.amount_zar}`,
      )
      .join('\n');
    downloadFile('tick3t-tickets.csv', header + body, 'text/csv;charset=utf-8');
  };

  const commissionRate = organizer?.commission_rate ?? 0;
  const gross = stats?.revenue_zar ?? 0;
  const estimatedFee = useMemo(() => (gross * Number(commissionRate)) / 100, [gross, commissionRate]);

  if (authLoading || loading) {
    return <p className="text-sm text-ink/45">Loading organizer…</p>;
  }

  if (!user) {
    const returnUrl = typeof window !== 'undefined' ? window.location.href : '/organizer';
    return (
      <div className="rounded-2xl border border-black/10 bg-mist p-8 text-center">
        <h1 className="text-xl font-extrabold">Organizer dashboard</h1>
        <p className="mt-2 text-sm text-ink/55">Sign in to manage your events.</p>
        <Link
          to={`/login/sell?return_url=${encodeURIComponent(returnUrl)}`}
          className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-brand px-5 py-2 text-sm font-bold text-white"
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (!organizer) {
    return (
      <>
        <PageSeo title="Organizer" description="Tick3t organizer dashboard." path="/organizer" />
        <div className="rounded-2xl border border-black/10 bg-mist p-8 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-brand">You&apos;re signed in</p>
          <h1 className="mt-2 text-xl font-extrabold">One more step to sell tickets</h1>
          <p className="mt-2 text-sm text-ink/55">
            Signed in as <strong>{user.email}</strong>. Register as an organizer, then a platform admin
            approves you before events go live.
          </p>
          <ol className="mx-auto mt-4 max-w-md list-decimal space-y-1 pl-5 text-left text-sm text-ink/60">
            <li>Submit your organizer application</li>
            <li>Wait for admin approval on Tick3t</li>
            <li>Create events and ticket types</li>
            <li>Share your event link — buyers pay via RedFace Pay</li>
          </ol>
          <Link
            to="/organizer/register"
            className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-brand px-5 py-2 text-sm font-bold text-white"
          >
            Register as organizer
          </Link>
        </div>
      </>
    );
  }

  const statusBanner =
    organizer.status === 'approved'
      ? null
      : organizer.status === 'pending'
        ? 'Your application is pending review. You will be able to publish events once approved.'
        : organizer.status === 'changes_requested'
          ? `Changes requested: ${organizer.admin_notes || 'Please update your details and wait for re-review.'}`
          : organizer.status === 'rejected'
            ? 'Your application was rejected. Contact support if you need help.'
            : 'Your organizer account is frozen. Contact support.';

  return (
    <>
      <PageSeo title="Organizer" description="Tick3t organizer dashboard." path="/organizer" />
      <div className="space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold">{organizer.company_name}</h1>
            <p className="mt-1 text-sm text-ink/55">{organizerStatusLabel(organizer.status)}</p>
          </div>
          {organizer.status === 'approved' && (
            <Link to="/staff" className="rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white">
              Door scan
            </Link>
          )}
        </header>

        {statusBanner && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-950">
            {statusBanner}
          </div>
        )}

        {organizer.status !== 'approved' && (
          <section className="space-y-4 rounded-2xl border border-black/10 bg-mist p-5">
            <h2 className="font-bold">What happens next</h2>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-ink/60">
              <li>A Tick3t admin reviews your application</li>
              <li>Once approved, this page unlocks event creation and ticket types</li>
              <li>Buyers pay on RedFace Pay; tickets appear in Tick3t</li>
            </ol>
            <div className="space-y-1 border-t border-black/10 pt-4 text-sm">
              <p>
                <span className="text-ink/45">Company</span> · {organizer.company_name}
              </p>
              <p>
                <span className="text-ink/45">Contact</span> · {organizer.contact_name}
              </p>
              <p>
                <span className="text-ink/45">Email</span> · {organizer.email}
              </p>
              {organizer.admin_notes ? (
                <p className="pt-2 text-amber-900">
                  <span className="font-semibold">Admin notes:</span> {organizer.admin_notes}
                </p>
              ) : null}
            </div>
            <p className="text-xs text-ink/45">
              Need help? Email info@redfacepay.co.za with your registered company name.
            </p>
          </section>
        )}

        {organizer.status === 'approved' && (
          <>
            <nav className="flex flex-wrap gap-1 border-b border-black/10 pb-2">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`rounded-lg px-3 py-2 text-xs font-semibold ${
                    tab === t.id ? 'bg-brand text-white' : 'text-ink/55 hover:text-ink'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            {tab === 'overview' && (
              <section className="space-y-4">
                {(() => {
                  const drafts = events.filter((e) => e.status === 'draft');
                  const live = events.filter((e) => e.status === 'on_sale' || e.status === 'published');
                  if (events.length === 0) {
                    return (
                      <div className="rounded-2xl border border-brand/20 bg-brand/5 px-4 py-3 text-sm">
                        <p className="font-bold">Get your first event live</p>
                        <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink/60">
                          <li>Create an event workspace</li>
                          <li>Add ticket types</li>
                          <li>Put the event on sale and share the link</li>
                        </ol>
                        <button
                          type="button"
                          onClick={() => setTab('events')}
                          className="mt-3 rounded-lg bg-brand px-3 py-2 text-xs font-bold text-white"
                        >
                          Create event
                        </button>
                      </div>
                    );
                  }
                  if (drafts.length > 0 && live.length === 0) {
                    return (
                      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-950">
                        <p className="font-bold">{drafts.length} draft event{drafts.length === 1 ? '' : 's'} not selling yet</p>
                        <p className="mt-1 text-ink/70">Add ticket types, then use Put on sale from the Events tab.</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="button" onClick={() => setTab('tickets')} className="rounded-lg bg-brand px-3 py-2 text-xs font-bold text-white">
                            Ticket types
                          </button>
                          <button type="button" onClick={() => setTab('events')} className="rounded-lg border border-black/15 px-3 py-2 text-xs font-bold">
                            Events
                          </button>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    { label: 'Tickets sold', value: String(stats?.total_tickets ?? 0) },
                    { label: 'Gross revenue', value: fmtMoney(stats?.revenue_zar ?? 0) },
                    { label: 'Checked in', value: String(stats?.checked_in ?? 0) },
                    { label: 'Live events', value: String(stats?.events_live ?? events.filter((e) => e.status === 'on_sale' || e.status === 'published').length) },
                  ].map((s) => (
                    <div key={s.label} className="rounded-2xl border border-black/10 bg-mist p-4">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">{s.label}</p>
                      <p className="mt-2 text-xl font-extrabold">{s.value}</p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={exportCsv} className="rounded-lg bg-brand px-3 py-2 text-xs font-bold text-white">
                    Export CSV
                  </button>
                  <button type="button" onClick={() => setTab('events')} className="rounded-lg border border-black/15 px-3 py-2 text-xs font-bold">
                    Create event
                  </button>
                  <Link to="/staff" className="rounded-lg border border-black/15 px-3 py-2 text-xs font-bold">
                    Door scan
                  </Link>
                </div>
                <ul className="space-y-2">
                  {events.slice(0, 5).map((ev) => (
                    <li key={ev.id} className="flex items-center justify-between rounded-xl border border-black/10 bg-mist px-4 py-3">
                      <div>
                        <p className="font-bold">{ev.title}</p>
                        <p className="text-xs text-ink/45">{ev.status.replace('_', ' ')}</p>
                      </div>
                      <button type="button" onClick={() => editEvent(ev)} className="text-xs font-semibold text-brand">
                        Edit
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {tab === 'events' && (
              <section className="space-y-6">
                <p className="text-sm text-ink/55">
                  Workflow: <strong>draft</strong> → add ticket types → <strong>on sale</strong> (public + selling).
                  Use <strong>published</strong> to list without selling yet.
                </p>
                <ul className="space-y-2">
                  {events.map((ev) => (
                    <li key={ev.id} className="rounded-xl border border-black/10 bg-mist px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-bold">{ev.title}</p>
                          <p className="text-xs text-ink/45">
                            /{ev.slug}
                            {ev.event_date ? ` · ${ev.event_date}` : ''}
                            {ev.venue ? ` · ${ev.venue}` : ''}
                          </p>
                        </div>
                        <span className="rounded-full bg-brand/15 px-2 py-1 text-[10px] font-bold uppercase text-brand">
                          {ev.status.replace('_', ' ')}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2">
                        <button type="button" onClick={() => editEvent(ev)} className="text-xs font-semibold text-brand">
                          Edit workspace
                        </button>
                        <button type="button" onClick={() => void copyEventLink(ev)} className="text-xs font-semibold text-ink/55">
                          Copy link
                        </button>
                        <Link
                          to={`/events/${ev.slug}?merchant_id=${encodeURIComponent(ev.merchant_id)}`}
                          className="text-xs font-semibold text-brand"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Preview
                        </Link>
                        {(ev.status === 'draft' || ev.status === 'published') && (
                          <button type="button" onClick={() => void publishEvent(ev, 'on_sale')} className="text-xs font-semibold text-emerald-700">
                            Put on sale
                          </button>
                        )}
                        {ev.status === 'draft' && (
                          <button type="button" onClick={() => void publishEvent(ev, 'published')} className="text-xs font-semibold text-ink/55">
                            List only
                          </button>
                        )}
                        {ev.status === 'on_sale' && (
                          <>
                            <button type="button" onClick={() => void publishEvent(ev, 'sold_out')} className="text-xs font-semibold text-amber-800">
                              Mark sold out
                            </button>
                            <button type="button" onClick={() => void publishEvent(ev, 'draft')} className="text-xs font-semibold text-ink/55">
                              Unpublish
                            </button>
                          </>
                        )}
                        {(ev.status === 'published' || ev.status === 'on_sale' || ev.status === 'sold_out') && (
                          <button type="button" onClick={() => void publishEvent(ev, 'completed')} className="text-xs font-semibold text-ink/55">
                            Complete
                          </button>
                        )}
                        {ev.status !== 'cancelled' && ev.status !== 'completed' && (
                          <button type="button" onClick={() => void publishEvent(ev, 'cancelled')} className="text-xs font-semibold text-red-700">
                            Cancel
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                  {events.length === 0 && (
                    <p className="text-sm text-ink/45">No events yet. Create one below, then add ticket types.</p>
                  )}
                </ul>

                <form onSubmit={saveEvent} className="space-y-4 rounded-2xl border border-black/10 bg-mist p-5">
                  <h2 className="text-sm font-bold">{eventForm.id ? 'Edit event workspace' : 'Create event'}</h2>

                  <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">Basics</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input className={inputClass} placeholder="Title" value={eventForm.title} onChange={(e) => setEventForm((f) => ({ ...f, title: e.target.value }))} required />
                    <input className={inputClass} placeholder="Slug (url)" value={eventForm.slug} onChange={(e) => setEventForm((f) => ({ ...f, slug: e.target.value }))} />
                    <input className={inputClass} placeholder="Venue" value={eventForm.venue} onChange={(e) => setEventForm((f) => ({ ...f, venue: e.target.value }))} />
                    <input className={inputClass} placeholder="City" value={eventForm.city} onChange={(e) => setEventForm((f) => ({ ...f, city: e.target.value }))} />
                    <label className="space-y-1 text-xs text-ink/55">
                      Event date
                      <input className={inputClass} type="date" value={eventForm.event_date} onChange={(e) => setEventForm((f) => ({ ...f, event_date: e.target.value }))} />
                    </label>
                    <label className="space-y-1 text-xs text-ink/55">
                      Doors
                      <input className={inputClass} type="time" value={eventForm.doors_time} onChange={(e) => setEventForm((f) => ({ ...f, doors_time: e.target.value }))} />
                    </label>
                    <label className="space-y-1 text-xs text-ink/55">
                      Ends
                      <input className={inputClass} type="time" value={eventForm.end_time} onChange={(e) => setEventForm((f) => ({ ...f, end_time: e.target.value }))} />
                    </label>
                    <input className={inputClass} placeholder="Category" value={eventForm.category} onChange={(e) => setEventForm((f) => ({ ...f, category: e.target.value }))} />
                    <input className={inputClass} placeholder="Capacity" type="number" min={0} value={eventForm.capacity} onChange={(e) => setEventForm((f) => ({ ...f, capacity: e.target.value }))} />
                    <input className={inputClass} placeholder="Age restriction" value={eventForm.age_restriction} onChange={(e) => setEventForm((f) => ({ ...f, age_restriction: e.target.value }))} />
                    <select className={inputClass} value={eventForm.status} onChange={(e) => setEventForm((f) => ({ ...f, status: e.target.value }))}>
                      {['draft', 'published', 'on_sale', 'sold_out', 'cancelled', 'completed'].map((s) => (
                        <option key={s} value={s}>{s.replace('_', ' ')}</option>
                      ))}
                    </select>
                  </div>

                  <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">Story & media</p>
                  <textarea className={inputClass} rows={3} placeholder="Description" value={eventForm.description} onChange={(e) => setEventForm((f) => ({ ...f, description: e.target.value }))} />
                  <textarea className={inputClass} rows={2} placeholder="Lineup" value={eventForm.lineup} onChange={(e) => setEventForm((f) => ({ ...f, lineup: e.target.value }))} />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input className={inputClass} placeholder="Hero image URL" value={eventForm.hero_image_url} onChange={(e) => setEventForm((f) => ({ ...f, hero_image_url: e.target.value }))} />
                    <input className={inputClass} placeholder="Poster image URL" value={eventForm.poster_image_url} onChange={(e) => setEventForm((f) => ({ ...f, poster_image_url: e.target.value }))} />
                    <input className={`${inputClass} sm:col-span-2`} placeholder="Maps URL" value={eventForm.maps_url} onChange={(e) => setEventForm((f) => ({ ...f, maps_url: e.target.value }))} />
                  </div>

                  <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">Policies & contact</p>
                  <textarea className={inputClass} rows={2} placeholder="Terms" value={eventForm.terms} onChange={(e) => setEventForm((f) => ({ ...f, terms: e.target.value }))} />
                  <textarea className={inputClass} rows={2} placeholder="Refund policy" value={eventForm.refund_policy} onChange={(e) => setEventForm((f) => ({ ...f, refund_policy: e.target.value }))} />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input className={inputClass} placeholder="Contact email" value={eventForm.contact_email} onChange={(e) => setEventForm((f) => ({ ...f, contact_email: e.target.value }))} />
                    <input className={inputClass} placeholder="Contact phone" value={eventForm.contact_phone} onChange={(e) => setEventForm((f) => ({ ...f, contact_phone: e.target.value }))} />
                    <input className={inputClass} placeholder="Website URL" value={eventForm.website_url} onChange={(e) => setEventForm((f) => ({ ...f, website_url: e.target.value }))} />
                    <input className={inputClass} placeholder="Instagram URL" value={eventForm.instagram_url} onChange={(e) => setEventForm((f) => ({ ...f, instagram_url: e.target.value }))} />
                    <input className={`${inputClass} sm:col-span-2`} placeholder="Facebook URL" value={eventForm.facebook_url} onChange={(e) => setEventForm((f) => ({ ...f, facebook_url: e.target.value }))} />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button type="submit" disabled={saving} className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">
                      {saving ? 'Saving…' : eventForm.id ? 'Save workspace' : 'Create event'}
                    </button>
                    {eventForm.id && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setTicketForm((f) => ({ ...f, event_id: eventForm.id }));
                            setTab('tickets');
                          }}
                          className="rounded-xl border border-black/15 px-4 py-2.5 text-sm font-bold"
                        >
                          Ticket types
                        </button>
                        <button type="button" onClick={() => setEventForm(emptyEventForm)} className="rounded-xl border border-black/15 px-4 py-2.5 text-sm font-bold">
                          New event
                        </button>
                      </>
                    )}
                  </div>
                </form>
              </section>
            )}

            {tab === 'tickets' && (
              <section className="space-y-4">
                <label className="block space-y-1.5">
                  <span className="text-xs font-semibold text-ink/55">Event</span>
                  <select
                    className={inputClass}
                    value={ticketForm.event_id}
                    onChange={(e) => void loadTypesForEvent(e.target.value)}
                  >
                    <option value="">Select event</option>
                    {events.map((ev) => (
                      <option key={ev.id} value={ev.id}>{ev.title}</option>
                    ))}
                  </select>
                </label>
                <ul className="space-y-2">
                  {ticketTypes.map((tt) => (
                    <li key={tt.id} className="rounded-xl border border-black/10 bg-mist px-4 py-3 text-sm">
                      <div className="flex justify-between gap-2">
                        <div>
                          <p className="font-bold">{tt.name} · {fmtMoney(tt.price_zar)}</p>
                          <p className="text-xs text-ink/45">
                            Cap {tt.capacity ?? '∞'} · Sold {tt.sold_count ?? 0} · {tt.status}
                            {tt.sale_opens_at ? ` · opens ${new Date(tt.sale_opens_at).toLocaleString()}` : ''}
                            {tt.sale_closes_at ? ` · closes ${new Date(tt.sale_closes_at).toLocaleString()}` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="text-xs font-semibold text-brand"
                          onClick={() =>
                            setTicketForm({
                              id: tt.id,
                              event_id: tt.event_id,
                              name: tt.name,
                              description: tt.description || '',
                              price_zar: String(tt.price_zar),
                              capacity: tt.capacity != null ? String(tt.capacity) : '',
                              sale_opens_at: tt.sale_opens_at ? tt.sale_opens_at.slice(0, 16) : '',
                              sale_closes_at: tt.sale_closes_at ? tt.sale_closes_at.slice(0, 16) : '',
                              max_per_customer: tt.max_per_customer != null ? String(tt.max_per_customer) : '',
                              status: tt.status,
                            })
                          }
                        >
                          Edit
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                <form onSubmit={saveTicketType} className="grid gap-3 rounded-2xl border border-black/10 bg-mist p-5 sm:grid-cols-2">
                  <h2 className="sm:col-span-2 text-sm font-bold">{ticketForm.id ? 'Edit ticket type' : 'Add ticket type'}</h2>
                  <input className={inputClass} placeholder="Name" value={ticketForm.name} onChange={(e) => setTicketForm((f) => ({ ...f, name: e.target.value }))} required />
                  <input className={inputClass} placeholder="Price ZAR" type="number" min={0} step="0.01" value={ticketForm.price_zar} onChange={(e) => setTicketForm((f) => ({ ...f, price_zar: e.target.value }))} required />
                  <input className={inputClass} placeholder="Capacity" type="number" min={0} value={ticketForm.capacity} onChange={(e) => setTicketForm((f) => ({ ...f, capacity: e.target.value }))} />
                  <input className={inputClass} placeholder="Max per customer" type="number" min={1} value={ticketForm.max_per_customer} onChange={(e) => setTicketForm((f) => ({ ...f, max_per_customer: e.target.value }))} />
                  <label className="space-y-1 text-xs text-ink/55">
                    Sale opens
                    <input className={inputClass} type="datetime-local" value={ticketForm.sale_opens_at} onChange={(e) => setTicketForm((f) => ({ ...f, sale_opens_at: e.target.value }))} />
                  </label>
                  <label className="space-y-1 text-xs text-ink/55">
                    Sale closes
                    <input className={inputClass} type="datetime-local" value={ticketForm.sale_closes_at} onChange={(e) => setTicketForm((f) => ({ ...f, sale_closes_at: e.target.value }))} />
                  </label>
                  <select className={inputClass} value={ticketForm.status} onChange={(e) => setTicketForm((f) => ({ ...f, status: e.target.value }))}>
                    {['draft', 'on_sale', 'sold_out', 'hidden'].map((s) => (
                      <option key={s} value={s}>{s.replace('_', ' ')}</option>
                    ))}
                  </select>
                  <input className={`${inputClass} sm:col-span-2`} placeholder="Description" value={ticketForm.description} onChange={(e) => setTicketForm((f) => ({ ...f, description: e.target.value }))} />
                  <button type="submit" className="sm:col-span-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white">
                    Save ticket type
                  </button>
                </form>
              </section>
            )}

            {tab === 'staff' && (
              <section className="space-y-4">
                <ul className="space-y-2">
                  {staff.map((s) => (
                    <li key={s.id} className="rounded-xl border border-black/10 bg-mist px-4 py-3 text-sm">
                      <p className="font-bold">{s.display_name || s.email}</p>
                      <p className="text-xs text-ink/45">{s.role} · {s.status} · {s.email}</p>
                    </li>
                  ))}
                  {staff.length === 0 && <p className="text-sm text-ink/45">No staff yet. Invite scanners for door ops.</p>}
                </ul>
                <form onSubmit={saveStaff} className="grid gap-3 rounded-2xl border border-black/10 bg-mist p-5 sm:grid-cols-2">
                  <h2 className="sm:col-span-2 text-sm font-bold">Invite staff</h2>
                  <input className={inputClass} type="email" placeholder="Email" value={staffForm.email} onChange={(e) => setStaffForm((f) => ({ ...f, email: e.target.value }))} required />
                  <input className={inputClass} placeholder="Display name" value={staffForm.display_name} onChange={(e) => setStaffForm((f) => ({ ...f, display_name: e.target.value }))} />
                  <select className={inputClass} value={staffForm.role} onChange={(e) => setStaffForm((f) => ({ ...f, role: e.target.value }))}>
                    {['scanner', 'manager', 'security', 'volunteer', 'marketing', 'finance', 'support'].map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <select className={inputClass} value={staffForm.event_id} onChange={(e) => setStaffForm((f) => ({ ...f, event_id: e.target.value }))}>
                    <option value="">All events</option>
                    {events.map((ev) => (
                      <option key={ev.id} value={ev.id}>{ev.title}</option>
                    ))}
                  </select>
                  <button type="submit" className="sm:col-span-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white">
                    Send invite
                  </button>
                </form>
              </section>
            )}

            {tab === 'promos' && (
              <section className="space-y-4">
                <ul className="space-y-2">
                  {promos.map((p) => (
                    <li key={p.id} className="rounded-xl border border-black/10 bg-mist px-4 py-3 text-sm">
                      <p className="font-bold font-mono">{p.code}</p>
                      <p className="text-xs text-ink/45">
                        {p.discount_type === 'percent' ? `${p.discount_value}%` : fmtMoney(p.discount_value)}
                        {' · '}
                        {p.redemption_count}/{p.max_redemptions ?? '∞'}
                        {p.active ? '' : ' · inactive'}
                      </p>
                    </li>
                  ))}
                </ul>
                <form onSubmit={savePromo} className="grid gap-3 rounded-2xl border border-black/10 bg-mist p-5 sm:grid-cols-2">
                  <h2 className="sm:col-span-2 text-sm font-bold">Create promo code</h2>
                  <input className={inputClass} placeholder="CODE" value={promoForm.code} onChange={(e) => setPromoForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} required />
                  <select className={inputClass} value={promoForm.discount_type} onChange={(e) => setPromoForm((f) => ({ ...f, discount_type: e.target.value as 'percent' | 'fixed' }))}>
                    <option value="percent">Percent</option>
                    <option value="fixed">Fixed ZAR</option>
                  </select>
                  <input className={inputClass} type="number" min={0.01} step="0.01" placeholder="Value" value={promoForm.discount_value} onChange={(e) => setPromoForm((f) => ({ ...f, discount_value: e.target.value }))} required />
                  <input className={inputClass} type="number" min={1} placeholder="Max redemptions" value={promoForm.max_redemptions} onChange={(e) => setPromoForm((f) => ({ ...f, max_redemptions: e.target.value }))} />
                  <select className={`${inputClass} sm:col-span-2`} value={promoForm.event_id} onChange={(e) => setPromoForm((f) => ({ ...f, event_id: e.target.value }))}>
                    <option value="">All events</option>
                    {events.map((ev) => (
                      <option key={ev.id} value={ev.id}>{ev.title}</option>
                    ))}
                  </select>
                  <button type="submit" className="sm:col-span-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white">
                    Save promo
                  </button>
                </form>
                <p className="text-xs text-ink/45">
                  Checkout discount application at Pay will wire to these codes in a follow-up; codes are stored and managed here now.
                </p>
              </section>
            )}

            {tab === 'refunds' && (
              <section className="space-y-3">
                {refunds.length === 0 && <p className="text-sm text-ink/45">No refund requests yet.</p>}
                {refunds.map((r) => (
                  <div key={r.id} className="rounded-xl border border-black/10 bg-mist px-4 py-3 text-sm">
                    <p className="font-bold">{r.buyer_email} · {fmtMoney(r.amount_zar ?? 0)}</p>
                    <p className="text-xs text-ink/45">{r.status} · {r.reason || 'No reason'}</p>
                    {r.status === 'pending' && (
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white"
                          onClick={async () => {
                            const res = await decideTick3tRefund(organizer.merchant_id!, r.id, 'approved');
                            if (!res.ok) toast.error(res.error || 'Failed');
                            else {
                              toast.success('Refund approved — ticket marked refunded. Complete money movement in RedFace Pay if needed.');
                              await reload();
                            }
                          }}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-bold"
                          onClick={async () => {
                            const res = await decideTick3tRefund(organizer.merchant_id!, r.id, 'rejected');
                            if (!res.ok) toast.error(res.error || 'Failed');
                            else {
                              toast.success('Refund rejected');
                              await reload();
                            }
                          }}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}

            {tab === 'finance' && (
              <section className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {[
                    { label: 'Gross ticket sales', value: fmtMoney(gross) },
                    { label: `Est. platform fee (${commissionRate}%)`, value: fmtMoney(estimatedFee) },
                    { label: 'Net after fee (est.)', value: fmtMoney(gross - estimatedFee) },
                    { label: 'Refunded volume', value: fmtMoney(stats?.refunded_zar ?? 0) },
                    { label: 'Valid tickets', value: String(stats?.valid ?? 0) },
                    { label: 'Checked in', value: String(stats?.checked_in ?? 0) },
                  ].map((s) => (
                    <div key={s.label} className="rounded-2xl border border-black/10 bg-mist p-4">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">{s.label}</p>
                      <p className="mt-2 text-lg font-extrabold">{s.value}</p>
                    </div>
                  ))}
                </div>
                <p className="text-sm text-ink/55">
                  Settlements, payouts, and bank transfers are handled by{' '}
                  <a href={REDFACE_PAY_ORIGIN} className="font-semibold text-brand" target="_blank" rel="noreferrer">
                    RedFace Pay
                  </a>
                  . Tick3t shows live sales; Pay moves the money.
                </p>
                <a
                  href={`${REDFACE_PAY_ORIGIN}/merchant`}
                  className="inline-flex rounded-xl border border-black/15 px-4 py-2.5 text-sm font-bold"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Pay merchant dashboard
                </a>
              </section>
            )}

            {tab === 'profile' && (
              <section className="rounded-2xl border border-black/10 bg-mist p-5 text-sm space-y-2">
                <h2 className="font-bold">Organizer profile</h2>
                <p><span className="text-ink/45">Company</span> · {organizer.company_name}</p>
                <p><span className="text-ink/45">Contact</span> · {organizer.contact_name}</p>
                <p><span className="text-ink/45">Email</span> · {organizer.email}</p>
                <p><span className="text-ink/45">Phone</span> · {organizer.phone || '—'}</p>
                <p><span className="text-ink/45">Country</span> · {organizer.country}</p>
                <p><span className="text-ink/45">Bank</span> · {organizer.bank_name || '—'} / {organizer.account_holder || '—'}</p>
                <p><span className="text-ink/45">Commission</span> · {organizer.commission_rate}%</p>
                <p className="pt-2 text-xs text-ink/45">
                  Bank / KYC changes for payouts are completed in RedFace Pay merchant onboarding.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
