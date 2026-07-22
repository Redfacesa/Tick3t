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
  organizerStatusLabel,
  setTick3tOrganizerStatus,
} from '@/lib/tick3t/api';
import type { Tick3tAdminDashboard, Tick3tOrganizer, Tick3tOrganizerStatus } from '@/lib/tick3t/types';

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
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dash, setDash] = useState<Tick3tAdminDashboard | null>(null);
  const [organizers, setOrganizers] = useState<Tick3tOrganizer[]>([]);
  const [filter, setFilter] = useState<Tick3tOrganizerStatus | ''>('pending');
  const [commissionById, setCommissionById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const isAdmin = await checkTick3tIsAdmin();
    setAllowed(isAdmin);
    if (!isAdmin) {
      setDash(null);
      setOrganizers([]);
      return;
    }
    const [d, list] = await Promise.all([
      fetchTick3tAdminDashboard(),
      fetchTick3tAdminOrganizers(filter || null),
    ]);
    setDash(d);
    setOrganizers(list.organizers);
    const rates: Record<string, string> = {};
    for (const o of list.organizers) rates[o.id] = String(o.commission_rate ?? 5);
    setCommissionById(rates);
  }, [filter]);

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
    return <p className="text-sm text-white/45">Loading admin…</p>;
  }

  if (!user) {
    const returnUrl = typeof window !== 'undefined' ? window.location.href : '/admin';
    return (
      <div className="rounded-2xl border border-white/10 bg-[#111] p-8 text-center">
        <h1 className="text-xl font-extrabold">Tick3t admin</h1>
        <Link
          to={`/login?return_url=${encodeURIComponent(returnUrl)}`}
          className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-[#FF4B4B] px-5 py-2 text-sm font-bold"
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="rounded-2xl border border-white/10 bg-[#111] p-8 text-center">
        <h1 className="text-xl font-extrabold">Not authorized</h1>
        <p className="mt-2 text-sm text-white/55">Tick3t admin access is required.</p>
        <Link to="/" className="mt-4 inline-block text-sm text-[#FF4B4B]">
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
          <p className="mt-1 text-sm text-white/55">Approve organizers, set commission, and track platform sales.</p>
        </header>

        {dash && (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { label: 'Pending organizers', value: dash.pending_organizers },
              { label: 'Approved organizers', value: dash.approved_organizers },
              { label: 'Live events', value: dash.events_live },
              { label: 'Tickets sold', value: dash.tickets_sold },
              { label: 'Revenue', value: fmtMoney(dash.revenue_zar) },
              { label: 'Checked in today', value: dash.checked_in_today },
            ].map((s) => (
              <div key={s.label} className="rounded-2xl border border-white/10 bg-[#111] p-4">
                <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">{s.label}</p>
                <p className="mt-2 text-xl font-extrabold">{s.value}</p>
              </div>
            ))}
          </section>
        )}

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-bold">Organizers</h2>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as Tick3tOrganizerStatus | '')}
              className="rounded-xl border border-white/12 bg-[#111] px-3 py-2 text-xs outline-none"
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
            <p className="text-sm text-white/45">No organizers in this filter.</p>
          ) : (
            <ul className="space-y-3">
              {organizers.map((o) => (
                <li key={o.id} className="rounded-2xl border border-white/10 bg-[#111] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-bold">{o.company_name}</p>
                      <p className="text-xs text-white/45">
                        {o.contact_name} · {o.email}
                      </p>
                      <p className="mt-1 text-xs text-white/40">
                        {organizerStatusLabel(o.status)}
                        {o.phone ? ` · ${o.phone}` : ''}
                      </p>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-white/55">
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
                        className="w-16 rounded-lg border border-white/12 bg-[#0a0a0a] px-2 py-1.5 text-center"
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <ActionBtn disabled={busyId === o.id} onClick={() => act(o.id, 'approved')} label="Approve" primary />
                    <ActionBtn
                      disabled={busyId === o.id}
                      onClick={() => act(o.id, 'changes_requested')}
                      label="Request changes"
                    />
                    <ActionBtn disabled={busyId === o.id} onClick={() => act(o.id, 'rejected')} label="Reject" />
                    <ActionBtn disabled={busyId === o.id} onClick={() => act(o.id, 'frozen')} label="Freeze" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
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
          ? 'min-h-[40px] rounded-lg bg-[#FF4B4B] px-3 py-2 text-xs font-bold disabled:opacity-50'
          : 'min-h-[40px] rounded-lg border border-white/15 px-3 py-2 text-xs font-bold disabled:opacity-50'
      }
    >
      {label}
    </button>
  );
}
