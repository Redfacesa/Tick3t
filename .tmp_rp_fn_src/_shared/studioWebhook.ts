import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { normalizeStudioPlanId } from './studioBilling.ts';

type BillingPatch = {
  status: string;
  downgradePlan: boolean;
  expiresAt: string | null;
  setExpires: boolean;
  clearExpires: boolean;
};

export function resolveStudioWebhookBillingPatch(
  eventType: string,
  data: Record<string, unknown>,
): BillingPatch | null {
  const nextPayRaw =
    data?.next_payment_date ||
    (data?.subscription as Record<string, unknown> | undefined)?.next_payment_date ||
    null;
  const nextPayMs = nextPayRaw ? Date.parse(String(nextPayRaw)) : NaN;
  const periodEndIso =
    Number.isFinite(nextPayMs) && nextPayMs > 0 ? new Date(nextPayMs).toISOString() : null;

  switch (eventType) {
    case 'charge.success':
    case 'subscription.create':
      return {
        status: 'active',
        downgradePlan: false,
        expiresAt: null,
        setExpires: true,
        clearExpires: true,
      };
    case 'subscription.disable':
    case 'subscription.not_renew': {
      if (periodEndIso && nextPayMs > Date.now()) {
        return {
          status: 'active',
          downgradePlan: false,
          expiresAt: periodEndIso,
          setExpires: true,
          clearExpires: false,
        };
      }
      return {
        status: 'cancelled',
        downgradePlan: true,
        expiresAt: new Date().toISOString(),
        setExpires: true,
        clearExpires: false,
      };
    }
    case 'invoice.payment_failed':
      return {
        status: 'attention',
        downgradePlan: false,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        setExpires: true,
        clearExpires: false,
      };
    default:
      return null;
  }
}

function resolveStudioPlanFromData(data: Record<string, unknown>): {
  planId: string;
  interval: 'monthly' | 'yearly';
} | null {
  const meta = (data.metadata ?? {}) as Record<string, unknown>;
  const fromMeta = String(
    meta.internalPlanId ?? meta.internal_plan_id ?? meta.plan_id ?? '',
  ).trim();
  if (fromMeta) {
    const planId = normalizeStudioPlanId(fromMeta) ?? fromMeta;
    const interval = meta.interval === 'yearly' ? 'yearly' : 'monthly';
    return { planId, interval };
  }
  return null;
}

export function isStudioPaystackMetadata(metadata: Record<string, unknown>): boolean {
  const pt = String(metadata.purchase_type ?? '');
  const app = String(metadata.app ?? '');
  return pt === 'studio_subscription' || app === 'studio';
}

/** Apply Paystack webhook side effects to billing_accounts + platform ledger. */
export async function applyStudioBillingWebhook(
  admin: SupabaseClient,
  eventType: string,
  data: Record<string, unknown>,
): Promise<{ handled: boolean; reason?: string }> {
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  if (!isStudioPaystackMetadata(metadata)) {
    return { handled: false, reason: 'not_studio' };
  }

  const lifecycle = resolveStudioWebhookBillingPatch(eventType, data);
  if (!lifecycle) return { handled: false, reason: 'ignored_event' };

  const customer = (data.customer ?? {}) as Record<string, unknown>;
  const email = String(customer.email ?? customer.customer_email ?? data.email ?? '').toLowerCase();
  const userId = String(metadata.user_id ?? metadata.userId ?? '').trim() || null;
  const resolved = resolveStudioPlanFromData(data);
  const interval = resolved?.interval ?? (metadata.interval === 'yearly' ? 'yearly' : 'monthly');
  const isActivation = eventType === 'charge.success' || eventType === 'subscription.create';
  const incomingPlan = resolved?.planId || (isActivation ? '' : 'free');

  const { error } = await admin.rpc('upsert_billing_account', {
    p_user_id: userId,
    p_email: email || 'unknown@paystack.webhook',
    p_plan_id: lifecycle.downgradePlan ? 'free' : incomingPlan,
    p_interval: interval,
    p_status: lifecycle.status,
    p_customer_code: customer.customer_code ?? customer.code ?? null,
    p_subscription_code: data.subscription_code
      ?? (data.subscription as Record<string, unknown> | undefined)?.subscription_code
      ?? null,
    p_last_reference: data.reference ?? null,
    p_next_payment_at: data.next_payment_date
      ?? (data.subscription as Record<string, unknown> | undefined)?.next_payment_date
      ?? null,
    p_metadata: { webhookEvent: eventType, paystackId: data.id, app: 'studio' },
    p_expires_at: lifecycle.clearExpires ? null : lifecycle.expiresAt,
    p_set_expires: lifecycle.setExpires,
    p_downgrade_plan: lifecycle.downgradePlan,
  });
  if (error) {
    console.error('studio webhook upsert_billing_account', error.message);
    throw error;
  }

  let syncUserId = userId;
  if (!syncUserId && email) {
    const { data: acct } = await admin
      .from('billing_accounts')
      .select('user_id')
      .ilike('customer_email', email)
      .maybeSingle();
    syncUserId = acct?.user_id ?? null;
  }
  if (syncUserId) {
    const { error: syncErr } = await admin.rpc('sync_studio_entitlement_to_ledger', {
      p_user_id: syncUserId,
    });
    if (syncErr) console.error('sync_studio_entitlement_to_ledger', syncErr.message);
  }

  return { handled: true };
}
