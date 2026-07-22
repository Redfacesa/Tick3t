import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import PageSeo from '@/components/PageSeo';
import Tick3tScanner from '@/components/tick3t/Tick3tScanner';
import { useAuth } from '@/contexts/AuthContext';
import { cls } from '@/lib/format';
import {
  fetchTick3tEvents,
  fetchTick3tOrganizerMe,
  validateAndCheckIn,
} from '@/lib/tick3t/api';
import { scanResultLabel, scanResultTone } from '@/lib/tick3t/qr';
import type { Tick3tEvent } from '@/lib/tick3t/types';

export default function Tick3tStaffPage() {
  const { user, merchant, loading: authLoading } = useAuth();
  const [merchantId, setMerchantId] = useState('');
  const [events, setEvents] = useState<Tick3tEvent[]>([]);
  const [eventId, setEventId] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: 'success' | 'warning' | 'error';
    title: string;
    detail?: string;
  } | null>(null);

  useEffect(() => {
    if (authLoading || !user) return;
    let on = true;
    void (async () => {
      const me = await fetchTick3tOrganizerMe();
      const mid = me?.merchant_id || merchant?.id || '';
      if (!on) return;
      setMerchantId(mid);
      if (mid) {
        const ev = await fetchTick3tEvents(mid);
        if (!on) return;
        setEvents(ev);
        if (ev[0]) setEventId(ev[0].id);
      }
    })();
    return () => {
      on = false;
    };
  }, [user, authLoading, merchant?.id]);

  const handleScan = useCallback(
    async (payload: string) => {
      if (!merchantId) {
        setFeedback({
          tone: 'error',
          title: 'No merchant context',
          detail: 'Select an approved organizer merchant first.',
        });
        return;
      }
      setScanBusy(true);
      setFeedback(null);
      try {
        const result = await validateAndCheckIn(merchantId, payload);
        const code = result.ok ? 'valid' : result.code;
        setFeedback({
          tone: scanResultTone(code),
          title: scanResultLabel(code),
          detail: result.ok
            ? `${(result.ticket as { buyer_name?: string }).buyer_name ?? 'Guest'} · ${(result.ticket as { event_name?: string }).event_name ?? ''}`
            : result.message,
        });
      } catch (err) {
        setFeedback({
          tone: 'error',
          title: 'Scan failed',
          detail: err instanceof Error ? err.message : 'Could not validate ticket',
        });
      } finally {
        setScanBusy(false);
      }
    },
    [merchantId],
  );

  if (authLoading) {
    return <p className="text-sm text-ink/45">Loading…</p>;
  }

  if (!user) {
    const returnUrl = typeof window !== 'undefined' ? window.location.href : '/staff';
    return (
      <div className="rounded-2xl border border-black/10 bg-mist p-8 text-center">
        <h1 className="text-xl font-extrabold">Staff check-in</h1>
        <p className="mt-2 text-sm text-ink/55">Sign in to scan tickets at the door.</p>
        <Link
          to={`/login?return_url=${encodeURIComponent(returnUrl)}`}
          className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-brand px-5 py-2 text-sm font-bold"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <>
      <PageSeo title="Staff check-in" description="Scan Tick3t tickets at the door." path="/staff" />
      <div className="mx-auto max-w-lg space-y-5">
        <header>
          <h1 className="text-2xl font-extrabold">Door check-in</h1>
          <p className="mt-1 text-sm text-ink/55">Scan a Tick3t QR or enter the code manually.</p>
        </header>

        <div className="space-y-3 rounded-2xl border border-black/10 bg-mist p-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-ink/55">Merchant ID</span>
            <input
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value.trim())}
              placeholder="Merchant UUID"
              className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 font-mono text-xs outline-none focus:border-brand/50"
            />
          </label>
          {events.length > 0 && (
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-ink/55">Event context</span>
              <select
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand/50"
              >
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <section className="rounded-2xl border border-black/10 bg-mist p-5">
          <Tick3tScanner onScan={handleScan} busy={scanBusy} />
          {feedback && (
            <div
              className={cls(
                'mt-4 rounded-xl border px-4 py-3',
                feedback.tone === 'success' && 'border-emerald-500/40 bg-emerald-500/10',
                feedback.tone === 'warning' && 'border-amber-500/40 bg-amber-500/10',
                feedback.tone === 'error' && 'border-red-500/40 bg-red-500/10',
              )}
            >
              <div className="flex items-start gap-2">
                {feedback.tone === 'success' ? (
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" />
                ) : (
                  <XCircle className="mt-0.5 h-5 w-5 text-red-400" />
                )}
                <div>
                  <p className="font-bold">{feedback.title}</p>
                  {feedback.detail && <p className="mt-1 text-sm text-ink/55">{feedback.detail}</p>}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
