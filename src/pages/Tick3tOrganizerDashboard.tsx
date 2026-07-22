import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import PageSeo from '@/components/PageSeo';
import { useAuth } from '@/contexts/AuthContext';
import { downloadFile } from '@/lib/download';
import { fmtMoney } from '@/lib/format';
import {
  fetchTick3tEvents,
  fetchTick3tOrganizerMe,
  fetchTick3tStats,
  fetchTick3tTickets,
  organizerStatusLabel,
  upsertTick3tEvent,
  upsertTick3tTicketType,
} from '@/lib/tick3t/api';
import type { Tick3tEvent, Tick3tOrganizer, Tick3tTicket } from '@/lib/tick3t/types';

const inputClass =
  'w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-brand/50';

export default function Tick3tOrganizerDashboard() {
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const showEventsFocus = location.pathname.includes('/events');

  const [organizer, setOrganizer] = useState<Tick3tOrganizer | null>(null);
  const [events, setEvents] = useState<Tick3tEvent[]>([]);
  const [tickets, setTickets] = useState<Tick3tTicket[]>([]);
  const [stats, setStats] = useState<{
    total_tickets: number;
    revenue_zar: number;
    valid: number;
    checked_in: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [eventForm, setEventForm] = useState({
    title: '',
    slug: '',
    venue: '',
    city: '',
    event_date: '',
    status: 'draft' as string,
  });
  const [ticketForm, setTicketForm] = useState({
    event_id: '',
    name: 'General',
    price_zar: '',
  });

  const reload = useCallback(async () => {
    const me = await fetchTick3tOrganizerMe();
    setOrganizer(me);
    if (me?.merchant_id && me.status === 'approved') {
      const [ev, tk, st] = await Promise.all([
        fetchTick3tEvents(me.merchant_id),
        fetchTick3tTickets(me.merchant_id),
        fetchTick3tStats(me.merchant_id),
      ]);
      setEvents(ev);
      setTickets(tk);
      setStats(st);
      if (!ticketForm.event_id && ev[0]) {
        setTicketForm((f) => ({ ...f, event_id: ev[0].id }));
      }
    } else {
      setEvents([]);
      setTickets([]);
      setStats(null);
    }
  }, [ticketForm.event_id]);

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

  const createEvent = async (e: React.FormEvent) => {
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
    setCreating(true);
    const { eventId, error } = await upsertTick3tEvent(organizer.merchant_id, {
      title: eventForm.title.trim(),
      slug,
      venue: eventForm.venue || null,
      city: eventForm.city || null,
      event_date: eventForm.event_date || null,
      status: eventForm.status as Tick3tEvent['status'],
    });
    setCreating(false);
    if (!eventId) {
      toast.error(error || 'Could not create event');
      return;
    }
    toast.success('Event saved');
    setEventForm({ title: '', slug: '', venue: '', city: '', event_date: '', status: 'draft' });
    setTicketForm((f) => ({ ...f, event_id: eventId }));
    await reload();
  };

  const addTicketType = async (e: React.FormEvent) => {
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
        name: ticketForm.name.trim(),
        price_zar: price,
        status: 'on_sale',
      },
    );
    if (!ticketTypeId) {
      toast.error(error || 'Could not add ticket type');
      return;
    }
    toast.success('Ticket type added');
    setTicketForm((f) => ({ ...f, name: 'General', price_zar: '' }));
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

  const printReport = () => {
    const w = window.open('', '_blank');
    if (!w) {
      toast.error('Allow pop-ups to print');
      return;
    }
    const rows = tickets
      .slice(0, 100)
      .map(
        (t) =>
          `<tr><td>${t.ticket_code}</td><td>${t.buyer_name || t.buyer_email}</td><td>${t.event_name}</td><td>${t.status}</td><td>${fmtMoney(t.amount_zar)}</td></tr>`,
      )
      .join('');
    w.document.write(`<!doctype html><html><head><title>Tick3t sales</title>
      <style>body{font-family:sans-serif;padding:24px} table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:6px;text-align:left}</style>
      </head><body>
      <h1>${organizer?.company_name || 'Tick3t'} — sales report</h1>
      <p>Tickets: ${stats?.total_tickets ?? tickets.length} · Revenue: ${fmtMoney(stats?.revenue_zar ?? 0)}</p>
      <table><thead><tr><th>Code</th><th>Guest</th><th>Event</th><th>Status</th><th>Amount</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <script>window.onload=()=>window.print()</script>
      </body></html>`);
    w.document.close();
  };

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
          <h1 className="text-xl font-extrabold">Start selling tickets</h1>
          <p className="mt-2 text-sm text-ink/55">Register as an organizer to create events on Tick3t.</p>
          <Link
            to="/organizer/register"
            className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-brand px-5 py-2 text-sm font-bold text-white"
          >
            Register
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
          <div className="flex flex-wrap gap-2">
            <Link to="/organizer" className="rounded-lg px-3 py-2 text-xs font-semibold text-ink/55 hover:text-ink">
              Overview
            </Link>
            <Link
              to="/organizer/events"
              className="rounded-lg px-3 py-2 text-xs font-semibold text-ink/55 hover:text-ink"
            >
              Events
            </Link>
            <Link to="/staff" className="rounded-lg px-3 py-2 text-xs font-semibold text-brand">
              Door scan
            </Link>
          </div>
        </header>

        {statusBanner && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-950">
            {statusBanner}
          </div>
        )}

        {organizer.status === 'approved' && (
          <>
            {!showEventsFocus && (
              <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { label: 'Tickets sold', value: String(stats?.total_tickets ?? 0) },
                  { label: 'Revenue', value: fmtMoney(stats?.revenue_zar ?? 0) },
                  { label: 'Valid', value: String(stats?.valid ?? 0) },
                  { label: 'Checked in', value: String(stats?.checked_in ?? 0) },
                ].map((s) => (
                  <div key={s.label} className="rounded-2xl border border-black/10 bg-mist p-4">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">{s.label}</p>
                    <p className="mt-2 text-xl font-extrabold">{s.value}</p>
                  </div>
                ))}
              </section>
            )}

            <section className="rounded-2xl border border-black/10 bg-mist p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-bold">Reports</h2>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={printReport}
                    className="min-h-[40px] rounded-lg border border-black/15 px-3 py-2 text-xs font-bold"
                  >
                    Print
                  </button>
                  <button
                    type="button"
                    onClick={exportCsv}
                    className="min-h-[40px] rounded-lg bg-brand px-3 py-2 text-xs font-bold text-white"
                  >
                    Export CSV
                  </button>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-bold">Your events</h2>
              {events.length === 0 ? (
                <p className="text-sm text-ink/45">No events yet. Create one below.</p>
              ) : (
                <ul className="space-y-2">
                  {events.map((ev) => (
                    <li key={ev.id} className="rounded-xl border border-black/10 bg-mist px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-bold">{ev.title}</p>
                          <p className="text-xs text-ink/45">
                            /{ev.slug}
                            {ev.event_date ? ` · ${ev.event_date}` : ''}
                          </p>
                        </div>
                        <span className="rounded-full bg-brand/15 px-2 py-1 text-[10px] font-bold uppercase text-brand">
                          {ev.status.replace('_', ' ')}
                        </span>
                      </div>
                      {ev.status === 'published' || ev.status === 'on_sale' ? (
                        <Link to={`/events/${ev.slug}`} className="mt-2 inline-block text-xs text-brand">
                          Public page
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-2xl border border-black/10 bg-mist p-5">
              <h2 className="text-sm font-bold">Create event</h2>
              <form onSubmit={createEvent} className="mt-4 grid gap-3 sm:grid-cols-2">
                <input
                  className={inputClass}
                  placeholder="Title"
                  value={eventForm.title}
                  onChange={(e) => setEventForm((f) => ({ ...f, title: e.target.value }))}
                  required
                />
                <input
                  className={inputClass}
                  placeholder="Slug (optional)"
                  value={eventForm.slug}
                  onChange={(e) => setEventForm((f) => ({ ...f, slug: e.target.value }))}
                />
                <input
                  className={inputClass}
                  placeholder="Venue"
                  value={eventForm.venue}
                  onChange={(e) => setEventForm((f) => ({ ...f, venue: e.target.value }))}
                />
                <input
                  className={inputClass}
                  placeholder="City"
                  value={eventForm.city}
                  onChange={(e) => setEventForm((f) => ({ ...f, city: e.target.value }))}
                />
                <input
                  type="date"
                  className={inputClass}
                  value={eventForm.event_date}
                  onChange={(e) => setEventForm((f) => ({ ...f, event_date: e.target.value }))}
                />
                <select
                  className={inputClass}
                  value={eventForm.status}
                  onChange={(e) => setEventForm((f) => ({ ...f, status: e.target.value }))}
                >
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                  <option value="on_sale">On sale</option>
                </select>
                <button
                  type="submit"
                  disabled={creating}
                  className="min-h-[44px] rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white sm:col-span-2 disabled:opacity-50"
                >
                  {creating ? 'Saving…' : 'Save event'}
                </button>
              </form>
            </section>

            <section className="rounded-2xl border border-black/10 bg-mist p-5">
              <h2 className="text-sm font-bold">Add ticket type</h2>
              <form onSubmit={addTicketType} className="mt-4 grid gap-3 sm:grid-cols-3">
                <select
                  className={inputClass}
                  value={ticketForm.event_id}
                  onChange={(e) => setTicketForm((f) => ({ ...f, event_id: e.target.value }))}
                  required
                >
                  <option value="">Select event</option>
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.title}
                    </option>
                  ))}
                </select>
                <input
                  className={inputClass}
                  placeholder="Name"
                  value={ticketForm.name}
                  onChange={(e) => setTicketForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
                <input
                  className={inputClass}
                  placeholder="Price (ZAR)"
                  type="number"
                  min={0}
                  step="1"
                  value={ticketForm.price_zar}
                  onChange={(e) => setTicketForm((f) => ({ ...f, price_zar: e.target.value }))}
                  required
                />
                <button
                  type="submit"
                  className="min-h-[44px] rounded-xl border border-black/15 px-4 py-2 text-sm font-bold sm:col-span-3"
                >
                  Add ticket type
                </button>
              </form>
            </section>
          </>
        )}
      </div>
    </>
  );
}
