import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import PageSeo from '@/components/PageSeo';
import { useAuth } from '@/contexts/AuthContext';
import { fetchMyTick3tTickets, requestTick3tRefund, ticketStatusLabel } from '@/lib/tick3t/api';
import { tick3tQrPayload } from '@/lib/tick3t/qr';
import type { Tick3tTicket } from '@/lib/tick3t/types';
import { fmtMoney } from '@/lib/format';

function qrImageUrl(token: string, size = 220): string {
  const payload = tick3tQrPayload(token);
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(payload)}`;
}

function isUpcoming(t: Tick3tTicket): boolean {
  if (!t.event_date) return true;
  const day = new Date(`${t.event_date}T23:59:59`);
  return day.getTime() >= Date.now() - 12 * 60 * 60 * 1000;
}

export default function Tick3tTicketsPage() {
  const { user, loading: authLoading } = useAuth();
  const [sp] = useSearchParams();
  const [tickets, setTickets] = useState<Tick3tTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);

  const load = async (opts?: { soft?: boolean }) => {
    if (!opts?.soft) setLoading(true);
    else setRefreshing(true);
    const { tickets: list, error: err } = await fetchMyTick3tTickets();
    setTickets(list);
    setError(err || '');
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    let on = true;
    void (async () => {
      setLoading(true);
      const { tickets: list, error: err } = await fetchMyTick3tTickets();
      if (!on) return;
      setTickets(list);
      setError(err || '');
      setLoading(false);
    })();
    return () => {
      on = false;
    };
  }, [user, authLoading]);

  useEffect(() => {
    if (sp.get('paid') !== '1') return;
    toast.success('Payment received — your tickets appear here once issued');
  }, [sp]);

  const { upcoming, past } = useMemo(() => {
    const up: Tick3tTicket[] = [];
    const done: Tick3tTicket[] = [];
    for (const t of tickets) {
      if (isUpcoming(t) && !['cancelled', 'refunded', 'expired'].includes(t.status)) up.push(t);
      else done.push(t);
    }
    return { upcoming: up, past: done };
  }, [tickets]);

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success('Ticket code copied');
    } catch {
      toast.message(code);
    }
  };

  if (authLoading || loading) {
    return <p className="text-sm text-ink/45">Loading your tickets…</p>;
  }

  if (!user) {
    const returnUrl = typeof window !== 'undefined' ? window.location.href : '/tickets';
    return (
      <>
        <PageSeo title="My tickets" description="Your Tick3t ticket wallet." path="/tickets" />
        <div className="rounded-2xl border border-black/10 bg-mist p-8 text-center">
          <h1 className="text-xl font-extrabold">My tickets</h1>
          <p className="mt-2 text-sm text-ink/55">Sign in to view tickets bought with your email.</p>
          <Link
            to={`/login/buy?return_url=${encodeURIComponent(returnUrl)}`}
            className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-brand px-5 py-2 text-sm font-bold text-white"
          >
            Sign in
          </Link>
        </div>
      </>
    );
  }

  const renderTicket = (t: Tick3tTicket) => {
    const focused = focusId === t.id;
    return (
      <li
        key={t.id}
        className="flex flex-col gap-4 rounded-2xl border border-black/10 bg-mist p-5 sm:flex-row sm:items-start"
      >
        {t.qr_token ? (
          <button
            type="button"
            onClick={() => setFocusId(focused ? null : t.id)}
            className="mx-auto sm:mx-0"
            title={focused ? 'Shrink QR' : 'Enlarge QR for door'}
          >
            <img
              src={qrImageUrl(t.qr_token, focused ? 320 : 200)}
              alt={`QR for ${t.ticket_code}`}
              className={`rounded-xl bg-white p-2 ${focused ? 'h-[280px] w-[280px]' : 'h-[180px] w-[180px]'}`}
            />
          </button>
        ) : (
          <div className="mx-auto flex h-[180px] w-[180px] items-center justify-center rounded-xl border border-dashed border-black/15 text-xs text-ink/35 sm:mx-0">
            QR pending
          </div>
        )}
        <div className="flex-1 space-y-1 text-center sm:text-left">
          <p className="font-bold">{t.event_name}</p>
          <p className="text-sm text-ink/55">{t.product_name}</p>
          <button
            type="button"
            onClick={() => void copyCode(t.ticket_code)}
            className="font-mono text-xs text-ink/40 underline-offset-2 hover:underline"
          >
            {t.ticket_code}
          </button>
          {t.venue && <p className="text-xs text-ink/40">{t.venue}</p>}
          {t.event_date && (
            <p className="text-xs text-ink/40">
              {new Date(t.event_date).toLocaleDateString(undefined, {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </p>
          )}
          {t.checked_in_at && (
            <p className="text-xs text-emerald-700">
              Checked in {new Date(t.checked_in_at).toLocaleString()}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2 sm:justify-start">
            <span className="rounded-full bg-black/5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-ink/70">
              {ticketStatusLabel(t.status)}
            </span>
            <span className="text-xs text-ink/45">{fmtMoney(t.amount_zar)}</span>
            {t.qr_token && (
              <button
                type="button"
                className="text-xs font-semibold text-brand"
                onClick={() => setFocusId(focused ? null : t.id)}
              >
                {focused ? 'Shrink QR' : 'Door view'}
              </button>
            )}
            {['valid', 'paid'].includes(t.status) && (
              <button
                type="button"
                className="text-xs font-semibold text-brand underline-offset-2 hover:underline"
                onClick={async () => {
                  const reason = window.prompt('Why do you need a refund?') || '';
                  const res = await requestTick3tRefund({
                    ticket_id: t.id,
                    reason: reason || undefined,
                  });
                  if (!res.ok) toast.error(res.error || 'Could not request refund');
                  else toast.success('Refund requested — the organizer will review it');
                }}
              >
                Request refund
              </button>
            )}
          </div>
        </div>
      </li>
    );
  };

  return (
    <>
      <PageSeo title="My tickets" description="Your Tick3t ticket wallet." path="/tickets" />
      <div className="space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold">My tickets</h1>
            <p className="mt-1 text-sm text-ink/55">
              Signed in as {user.email}. Tap a QR for door view.
            </p>
          </div>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void load({ soft: true })}
            className="rounded-xl border border-black/15 px-3 py-2 text-xs font-bold disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </header>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {tickets.length === 0 ? (
          <div className="rounded-2xl border border-black/10 bg-mist p-8 text-center">
            <p className="font-semibold">No tickets yet</p>
            <p className="mt-2 text-sm text-ink/55">
              After you pay on RedFace Pay, tickets show up here under this email.
            </p>
            <Link to="/" className="mt-4 inline-block text-sm font-semibold text-brand">
              Browse events
            </Link>
          </div>
        ) : (
          <div className="space-y-8">
            <section className="space-y-4">
              <h2 className="text-sm font-bold">Upcoming</h2>
              {upcoming.length === 0 ? (
                <p className="text-sm text-ink/45">No upcoming tickets.</p>
              ) : (
                <ul className="space-y-4">{upcoming.map(renderTicket)}</ul>
              )}
            </section>
            {past.length > 0 && (
              <section className="space-y-4">
                <h2 className="text-sm font-bold">Past & other</h2>
                <ul className="space-y-4">{past.map(renderTicket)}</ul>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
}
