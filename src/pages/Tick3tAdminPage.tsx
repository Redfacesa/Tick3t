import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import PageSeo from '@/components/PageSeo';
import { useAuth } from '@/contexts/AuthContext';
import { fmtMoney } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import {
  checkTick3tIsAdmin,
  fetchTick3tAdminDashboard,
  fetchTick3tAdminOrganizers,
  fetchTick3tAdminSalesFeed,
  organizerStatusLabel,
  setTick3tOrganizerStatus,
  ticketStatusLabel,
  type Tick3tAdminSale,
} from '@/lib/tick3t/api';
import type { Tick3tAdminDashboard, Tick3tOrganizer, Tick3tOrganizerStatus } from '@/lib/tick3t/types';

type AdminTab = 'overview' | 'organizers' | 'sales';

async function provisionPaystackSubaccount(merchantId: string): Promise<{ ok: boolean; message?: string }> {
  const { data, error } = await supabase.functions.invoke('redface-pay', {
    body: { action: 'create_subaccount', merchant_id: merchantId },
  });
  if (error || !data?.status) {
    let msg = data?.message || error?.message || 'Subaccount creation failed';
    try {
      const body = await (error as { context?: { json?: () => Promise<{ message?: string }> } })?.context?.json?.();
      if (body?.message) msg = body.message;
    } catch {
      /* ignore */
    }
    return { ok: false, message: msg };
  }
  return { ok: true, message: data.subaccount ? `Subaccount ${data.subaccount}` : undefined };
}

export default function Tick3tAdminPage() {
  const { user, loading: authLoading } = useAuth();
  const [tab, setTab] = useState<AdminTab>('organizers');
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dash, setDash] = useState<Tick3tAdminDashboard | null>(null);
  const [organizers, setOrganizers] = useState<Tick3tOrganizer[]>([]);
  const [sales, setSales] = useState<Tick3tAdminSale[]>([]);
  const [filter, setFilter] = useState<Tick3tOrganizerStatus | ''>('pending');
  const [commissionById, setCommissionById] = useState<Record<string, string>>({});
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const isAdmin = await checkTick3tIsAdmin(user?.email);
    setAllowed(isAdmin);
    if (!isAdmin) {
      setDash(null);
      setOrganizers([]);
      setSales([]);
      return;
    }
    const [d, list, feed] = await Promise.all([
      fetchTick3tAdminDashboard(),
      fetchTick3tAdminOrganizers(filter || null),
      fetchTick3tAdminSalesFeed(80),
    ]);
    setDash(d);
    setOrganizers(list.organizers);
    setSales(feed);
    const rates: Record<string, string> = {};
    for (const o of list.organizers) rates[o.id] = String(o.commission_rate ?? 5);
    setCommissionById(rates);
  }, [filter, user?.email]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      setAllowed(false);
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

  const act = async (id: string, status: Tick3tOrganizerStatus) => {
    setBusyId(id);
    const rate = Number(commissionById[id]);
    const result = await setTick3tOrganizerStatus(id, status, {
      commissionRate: Number.isFinite(rate) ? rate : undefined,
      notes: notesById[id]?.trim() || undefined,
    });
    if (!result.ok) {
      setBusyId(null);
      toast.error(result.error || 'Update failed');
      return;
    }

    if (status === 'approved' && result.needsSubaccount && result.merchantId) {
      const sub = await provisionPaystackSubaccount(result.merchantId);
      setBusyId(null);
      if (!sub.ok) {
        toast.success('Organizer approved. Subaccount still needed.');
        toast.error(sub.message || 'Could not create Paystack subaccount');
      } else {
        toast.success(`Organizer approved. ${sub.message || 'Selling enabled.'}`);
      }
    } else {
      setBusyId(null);
      toast.success(`Organizer ${organizerStatusLabel(status).toLowerCase()}`);
    }
    await reload();
  };

  if (authLoading || loading) {
    return <p className="text-sm text-ink/45">Loading admin…</p>;
  }

  if (!user) {
    const returnUrl = typeof window !== 'undefined' ? window.location.href : '/admin';
    return (
      <div className="rounded-2xl border border-black/10 bg-mist p-8 text-center">
        <h1 className="text-xl font-extrabold">Tick3t admin</h1>
        <p className="mt-2 text-sm text-ink/55">Platform owners approve sellers and monitor ticket sales.</p>
        <Link
          to={`/login/admin?return_url=${encodeURIComponent(returnUrl)}`}
          className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-brand px-5 py-2 text-sm font-bold text-white"
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="rounded-2xl border border-black/10 bg-mist p-8 text-center">
        <h1 className="text-xl font-extrabold">Not authorized</h1>
        <p className="mt-2 text-sm text-ink/55">Tick3t admin access is required (RedFace Pay / Entendre).</p>
        <Link to="/" className="mt-4 inline-block text-sm text-brand">
          Back to events
        </Link>
      </div>
    );
  }

  return (
    <>
      <PageSeo
        title="Tick3t admin"
        description="Approve organizers and monitor Tick3t."
        path="/admin"
        noindex
      />
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-extrabold">Tick3t admin</h1>
          <p className="mt-1 text-sm text-ink/55">
            Approve organizers so they can sell. Monitor live ticket sales across the platform.
          </p>
        </header>

        <nav className="flex flex-wrap gap-1 border-b border-black/10 pb-2">
          {(
            [
              { id: 'overview' as const, label: 'Overview' },
              { id: 'organizers' as const, label: `Organizers${dash ? ` (${dash.pending_organizers} pending)` : ''}` },
              { id: 'sales' as const, label: 'Sales feed' },
            ] as const
          ).map((t) => (
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

        {tab === 'overview' && dash && (
          <section className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { label: 'Pending organizers', value: dash.pending_organizers, action: () => { setFilter('pending'); setTab('organizers'); } },
                { label: 'Approved organizers', value: dash.approved_organizers, action: () => { setFilter('approved'); setTab('organizers'); } },
                { label: 'Live events', value: dash.events_live },
                { label: 'Tickets sold', value: dash.tickets_sold, action: () => setTab('sales') },
                { label: 'Revenue', value: fmtMoney(dash.revenue_zar), action: () => setTab('sales') },
                { label: 'Checked in today', value: dash.checked_in_today },
              ].map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={s.action}
                  disabled={!s.action}
                  className="rounded-2xl border border-black/10 bg-mist p-4 text-left transition hover:border-brand/40 disabled:hover:border-black/10"
                >
                  <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">{s.label}</p>
                  <p className="mt-2 text-xl font-extrabold">{s.value}</p>
                  {s.action && <p className="mt-2 text-[10px] font-semibold text-brand">Open →</p>}
                </button>
              ))}
            </div>
            <div className="rounded-2xl border border-black/10 bg-mist p-4 text-sm text-ink/60">
              <p className="font-bold text-ink">What you can do here</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>Open <strong>Organizers</strong> → approve pending sellers (set commission first).</li>
                <li>Approval creates / links their RedFace Pay merchant for payouts.</li>
                <li>Watch <strong>Sales feed</strong> for tickets issued across all organizers.</li>
              </ol>
            </div>
          </section>
        )}

        {tab === 'organizers' && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-bold">Organizers</h2>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as Tick3tOrganizerStatus | '')}
                className="rounded-xl border border-black/10 bg-mist px-3 py-2 text-xs outline-none"
              >
                <option value="">All</option>
                <option value="pending">Pending</option>
                <option value="changes_requested">Changes requested</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="frozen">Frozen</option>
              </select>
            </div>

            {organizers.length === 0 ? (
              <p className="text-sm text-ink/45">No organizers in this filter.</p>
            ) : (
              <ul className="space-y-3">
                {organizers.map((o) => (
                  <li key={o.id} className="rounded-2xl border border-black/10 bg-mist p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-bold">{o.company_name}</p>
                        <p className="text-xs text-ink/45">
                          {o.contact_name} · {o.email}
                        </p>
                        <p className="mt-1 text-xs text-ink/40">
                          {organizerStatusLabel(o.status)}
                          {o.phone ? ` · ${o.phone}` : ''}
                          {o.country ? ` · ${o.country}` : ''}
                        </p>
                        {o.admin_notes && (
                          <p className="mt-2 text-xs text-amber-800">Notes: {o.admin_notes}</p>
                        )}
                        {(o.bank_name || o.account_number) && (
                          <p className="mt-1 text-xs text-ink/40">
                            Bank: {o.bank_name || '—'} · {o.account_holder || '—'} · {o.account_number || '—'}
                          </p>
                        )}
                      </div>
                      <label className="flex items-center gap-2 text-xs text-ink/55">
                        Commission %
                        <input
                          type="number"
                          min={0}
                          max={50}
                          step="0.5"
                          value={commissionById[o.id] ?? '5'}
                          onChange={(e) =>
                            setCommissionById((prev) => ({ ...prev, [o.id]: e.target.value }))
                          }
                          className="w-16 rounded-lg border border-black/10 bg-white px-2 py-1.5 text-center"
                        />
                      </label>
                    </div>
                    <input
                      className="mt-3 w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-xs outline-none"
                      placeholder="Admin notes (optional — shown when requesting changes)"
                      value={notesById[o.id] ?? ''}
                      onChange={(e) => setNotesById((prev) => ({ ...prev, [o.id]: e.target.value }))}
                    />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <ActionBtn disabled={busyId === o.id} onClick={() => act(o.id, 'approved')} label="Approve & enable selling" primary />
                      <ActionBtn
                        disabled={busyId === o.id}
                        onClick={() => act(o.id, 'changes_requested')}
                        label="Request changes"
                      />
                      <ActionBtn disabled={busyId === o.id} onClick={() => act(o.id, 'rejected')} label="Reject" />
                      <ActionBtn disabled={busyId === o.id} onClick={() => act(o.id, 'frozen')} label="Freeze" />
                      {o.status === 'frozen' && (
                        <ActionBtn disabled={busyId === o.id} onClick={() => act(o.id, 'approved')} label="Unfreeze (approve)" />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {tab === 'sales' && (
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-bold">Recent ticket sales</h2>
              <button
                type="button"
                onClick={() => void reload()}
                className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-bold"
              >
                Refresh
              </button>
            </div>
            {sales.length === 0 ? (
              <p className="text-sm text-ink/45">No Tick3t ticket sales yet.</p>
            ) : (
              <ul className="space-y-2">
                {sales.map((s) => (
                  <li key={s.id} className="rounded-xl border border-black/10 bg-mist px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-bold">{s.event_name}</p>
                        <p className="text-xs text-ink/45">
                          {s.product_name} · {s.buyer_name || s.buyer_email}
                        </p>
                        <p className="mt-1 text-xs text-ink/40">
                          {s.organizer_name || 'Organizer'} · {s.ticket_code}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold">{fmtMoney(s.amount_zar)}</p>
                        <p className="text-[10px] uppercase text-ink/45">{ticketStatusLabel(s.status)}</p>
                        <p className="text-[10px] text-ink/35">
                          {new Date(s.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </>
  );
}

function ActionBtn({
  label,
  onClick,
  disabled,
  primary,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        primary
          ? 'min-h-[40px] rounded-lg bg-brand px-3 py-2 text-xs font-bold text-white disabled:opacity-50'
          : 'min-h-[40px] rounded-lg border border-black/15 px-3 py-2 text-xs font-bold disabled:opacity-50'
      }
    >
      {label}
    </button>
  );
}
