import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageSeo from '@/components/PageSeo';
import { useAuth } from '@/contexts/AuthContext';
import { fetchMyTick3tTickets, ticketStatusLabel } from '@/lib/tick3t/api';
import { tick3tQrPayload } from '@/lib/tick3t/qr';
import type { Tick3tTicket } from '@/lib/tick3t/types';
import { fmtMoney } from '@/lib/format';

function qrImageUrl(token: string): string {
  const payload = tick3tQrPayload(token);
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(payload)}`;
}

export default function Tick3tTicketsPage() {
  const { user, loading: authLoading } = useAuth();
  const [tickets, setTickets] = useState<Tick3tTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  if (authLoading || loading) {
    return <p className="text-sm text-white/45">Loading your tickets…</p>;
  }

  if (!user) {
    const returnUrl = typeof window !== 'undefined' ? window.location.href : '/tickets';
    return (
      <>
        <PageSeo title="My tickets" description="Your Tick3t ticket wallet." path="/tickets" />
        <div className="rounded-2xl border border-white/10 bg-[#111] p-8 text-center">
          <h1 className="text-xl font-extrabold">My tickets</h1>
          <p className="mt-2 text-sm text-white/55">Sign in to view tickets bought with your email.</p>
          <Link
            to={`/login?return_url=${encodeURIComponent(returnUrl)}`}
            className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-[#FF4B4B] px-5 py-2 text-sm font-bold text-white"
          >
            Sign in
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageSeo title="My tickets" description="Your Tick3t ticket wallet." path="/tickets" />
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-extrabold">My tickets</h1>
          <p className="mt-1 text-sm text-white/55">Show the QR at the door. Keep this page ready.</p>
        </header>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {tickets.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-[#111] p-8 text-center">
            <p className="font-semibold">No tickets yet</p>
            <Link to="/" className="mt-4 inline-block text-sm text-[#FF4B4B]">
              Browse events
            </Link>
          </div>
        ) : (
          <ul className="space-y-4">
            {tickets.map((t) => (
              <li
                key={t.id}
                className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-[#111] p-5 sm:flex-row sm:items-center"
              >
                {t.qr_token ? (
                  <img
                    src={qrImageUrl(t.qr_token)}
                    alt={`QR for ${t.ticket_code}`}
                    className="mx-auto h-[180px] w-[180px] rounded-xl bg-white p-2 sm:mx-0"
                  />
                ) : (
                  <div className="mx-auto flex h-[180px] w-[180px] items-center justify-center rounded-xl border border-dashed border-white/20 text-xs text-white/35 sm:mx-0">
                    QR pending
                  </div>
                )}
                <div className="flex-1 space-y-1 text-center sm:text-left">
                  <p className="font-bold">{t.event_name}</p>
                  <p className="text-sm text-white/55">{t.product_name}</p>
                  <p className="font-mono text-xs text-white/40">{t.ticket_code}</p>
                  {t.venue && <p className="text-xs text-white/40">{t.venue}</p>}
                  {t.event_date && (
                    <p className="text-xs text-white/40">
                      {new Date(t.event_date).toLocaleDateString()}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-2 sm:justify-start">
                    <span className="rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white/70">
                      {ticketStatusLabel(t.status)}
                    </span>
                    <span className="text-xs text-white/45">{fmtMoney(t.amount_zar)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
