import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Wifi, WifiOff, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import PageSeo from '@/components/PageSeo';
import Tick3tScanner from '@/components/tick3t/Tick3tScanner';
import { useAuth } from '@/contexts/AuthContext';
import { cls } from '@/lib/format';
import {
  fetchTick3tEvents,
  fetchTick3tOrganizerMe,
  fetchTick3tStaffAssignments,
  validateAndCheckIn,
} from '@/lib/tick3t/api';
import {
  enqueueOfflineScan,
  flushOfflineScans,
  listOfflineScans,
} from '@/lib/tick3t/offlineScanQueue';
import { scanResultLabel, scanResultTone } from '@/lib/tick3t/qr';
import type { Tick3tEvent, Tick3tStaffAssignment } from '@/lib/tick3t/types';

function playTone(kind: 'ok' | 'warn' | 'err') {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = kind === 'ok' ? 880 : kind === 'warn' ? 520 : 220;
    gain.gain.value = 0.05;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.stop(ctx.currentTime + 0.2);
    void ctx.resume();
  } catch {
    /* ignore audio failures */
  }
}

export default function Tick3tStaffPage() {
  const { user, merchant, loading: authLoading } = useAuth();
  const [sp] = useSearchParams();
  const [merchantId, setMerchantId] = useState(sp.get('merchant_id') || '');
  const [events, setEvents] = useState<Tick3tEvent[]>([]);
  const [assignments, setAssignments] = useState<Tick3tStaffAssignment[]>([]);
  const [eventId, setEventId] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [queued, setQueued] = useState(0);
  const [sessionOk, setSessionOk] = useState(0);
  const [sessionBad, setSessionBad] = useState(0);
  const [feedback, setFeedback] = useState<{
    tone: 'success' | 'warning' | 'error';
    title: string;
    detail?: string;
  } | null>(null);

  const refreshQueueCount = useCallback(() => {
    setQueued(listOfflineScans(merchantId || undefined).length);
  }, [merchantId]);

  const liveEvents = useMemo(() => {
    const live = events.filter((e) => e.status === 'on_sale' || e.status === 'published' || e.status === 'sold_out');
    return live.length ? live : events;
  }, [events]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    if (authLoading || !user) return;
    let on = true;
    void (async () => {
      const [me, staffAssign] = await Promise.all([
        fetchTick3tOrganizerMe(),
        fetchTick3tStaffAssignments(),
      ]);
      if (!on) return;
      setAssignments(staffAssign);
      const mid =
        me?.merchant_id || merchant?.id || staffAssign[0]?.merchant_id || sp.get('merchant_id') || '';
      setMerchantId(mid);
      if (mid) {
        const ev = await fetchTick3tEvents(mid);
        if (!on) return;
        setEvents(ev);
        const preferred =
          ev.find((e) => e.status === 'on_sale') ||
          ev.find((e) => e.status === 'published') ||
          ev[0];
        if (preferred) setEventId(preferred.id);
      }
    })();
    return () => {
      on = false;
    };
  }, [user, authLoading, merchant?.id, sp]);

  useEffect(() => {
    refreshQueueCount();
  }, [refreshQueueCount]);

  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => setFeedback(null), 4500);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const syncQueue = useCallback(async () => {
    if (!merchantId || !navigator.onLine) return;
    setSyncBusy(true);
    const { flushed, failed } = await flushOfflineScans(async (mid, payload) => {
      const result = await validateAndCheckIn(mid, payload);
      return { ok: result.ok };
    });
    setSyncBusy(false);
    refreshQueueCount();
    if (flushed > 0) toast.success(`Synced ${flushed} offline scan${flushed === 1 ? '' : 's'}`);
    if (failed > 0) toast.error(`${failed} scan${failed === 1 ? '' : 's'} still offline`);
  }, [merchantId, refreshQueueCount]);

  useEffect(() => {
    if (!online || !merchantId) return;
    void syncQueue();
  }, [online, merchantId, syncQueue]);

  const handleScan = useCallback(
    async (payload: string) => {
      if (!merchantId) {
        setFeedback({
          tone: 'error',
          title: 'No merchant context',
          detail: 'Sign in as an organizer or pick a staff assignment.',
        });
        playTone('err');
        return;
      }

      if (!navigator.onLine) {
        enqueueOfflineScan(merchantId, payload);
        refreshQueueCount();
        setFeedback({
          tone: 'warning',
          title: 'Queued offline',
          detail: 'Scan saved on this device. It will sync when you are back online.',
        });
        playTone('warn');
        return;
      }

      setScanBusy(true);
      setFeedback(null);
      try {
        const result = await validateAndCheckIn(merchantId, payload);
        const code = result.ok ? 'valid' : result.code;
        const tone = scanResultTone(code);
        setFeedback({
          tone,
          title: scanResultLabel(code),
          detail: result.ok
            ? `${(result.ticket as { buyer_name?: string }).buyer_name ?? 'Guest'} · ${(result.ticket as { event_name?: string }).event_name ?? ''}${
                eventId ? '' : ''
              }`
            : result.message,
        });
        if (result.ok) {
          setSessionOk((n) => n + 1);
          playTone('ok');
        } else {
          setSessionBad((n) => n + 1);
          playTone(tone === 'warning' ? 'warn' : 'err');
        }
      } catch (err) {
        enqueueOfflineScan(merchantId, payload);
        refreshQueueCount();
        setFeedback({
          tone: 'warning',
          title: 'Saved offline',
          detail: err instanceof Error ? err.message : 'Could not reach server — queued locally',
        });
        playTone('warn');
      } finally {
        setScanBusy(false);
      }
    },
    [merchantId, refreshQueueCount, eventId],
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
          to={`/login/sell?return_url=${encodeURIComponent(returnUrl)}`}
          className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-brand px-5 py-2 text-sm font-bold text-white"
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
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold">Door check-in</h1>
            <p className="mt-1 text-sm text-ink/55">Camera stays on — keep scanning guests.</p>
          </div>
          <span
            className={cls(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase',
              online ? 'bg-emerald-500/15 text-emerald-800' : 'bg-amber-500/15 text-amber-900',
            )}
          >
            {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {online ? 'Online' : 'Offline'}
          </span>
        </header>

        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'In', value: String(sessionOk) },
            { label: 'Rejected', value: String(sessionBad) },
            { label: 'Queued', value: String(queued) },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-black/10 bg-mist px-3 py-2 text-center">
              <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">{s.label}</p>
              <p className="mt-1 text-lg font-extrabold">{s.value}</p>
            </div>
          ))}
        </div>

        {queued > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-950">
            <span>
              {queued} scan{queued === 1 ? '' : 's'} waiting to sync
            </span>
            <button
              type="button"
              disabled={!online || syncBusy}
              onClick={() => void syncQueue()}
              className="rounded-lg bg-amber-900 px-3 py-1.5 font-bold text-white disabled:opacity-40"
            >
              {syncBusy ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        )}

        <div className="space-y-3 rounded-2xl border border-black/10 bg-mist p-4">
          {assignments.length > 0 && (
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-ink/55">Assignment</span>
              <select
                value={merchantId}
                onChange={(e) => setMerchantId(e.target.value)}
                className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand/50"
              >
                {assignments.map((a) => (
                  <option key={a.staff_id} value={a.merchant_id}>
                    {a.company_name || a.merchant_id} · {a.role}
                  </option>
                ))}
              </select>
            </label>
          )}
          {liveEvents.length > 0 && (
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-ink/55">Event context</span>
              <select
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand/50"
              >
                {liveEvents.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.title} · {ev.status.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-xs font-semibold text-ink/45 underline-offset-2 hover:underline"
          >
            {showAdvanced ? 'Hide advanced' : 'Advanced merchant ID'}
          </button>
          {showAdvanced && (
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-ink/55">Merchant ID</span>
              <input
                value={merchantId}
                onChange={(e) => setMerchantId(e.target.value.trim())}
                placeholder="Merchant UUID"
                className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 font-mono text-xs outline-none focus:border-brand/50"
              />
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
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-700" />
                ) : (
                  <XCircle className="mt-0.5 h-5 w-5 text-red-600" />
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
