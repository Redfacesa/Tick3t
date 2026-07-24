/** Activate a marketplace sponsorship row (shared by redface-pay + paystack-webhook). */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { normalizeSponsoredDays } from './sponsoredListings.ts';

export async function activateSponsoredListingRow(
  admin: SupabaseClient,
  sponsoredId: string,
  reference: string,
  amountPaid: number,
  currency: string | null,
  durationDays: number,
  subscriptionCode?: string | null,
  extraMeta?: Record<string, unknown>,
) {
  if (!sponsoredId) return;
  await admin.rpc('expire_sponsored_listings').then(() => {}, () => {});
  const { data: sponsoredRow } = await admin
    .from('merchant_sponsored_listings')
    .select('product_id, status, ends_at, meta')
    .eq('id', sponsoredId)
    .maybeSingle();
  if (sponsoredRow?.product_id) {
    await admin.from('merchant_sponsored_listings')
      .update({ status: 'expired' })
      .eq('product_id', sponsoredRow.product_id)
      .eq('status', 'active')
      .neq('id', sponsoredId);
  }
  const days = normalizeSponsoredDays(durationDays);
  const now = new Date();
  const base = sponsoredRow?.status === 'active' && sponsoredRow.ends_at
    && new Date(sponsoredRow.ends_at).getTime() > now.getTime()
    ? new Date(sponsoredRow.ends_at)
    : now;
  const ends = new Date(base.getTime() + days * 86400000);
  const meta = {
    ...((sponsoredRow?.meta as Record<string, unknown>) || {}),
    ...(extraMeta || {}),
  };
  const patch: Record<string, unknown> = {
    status: 'active',
    paystack_reference: reference,
    ends_at: ends.toISOString(),
    amount_paid: amountPaid,
    currency: currency ?? 'ZAR',
    priority: 100 + days,
    duration_days: days,
    meta,
  };
  if (sponsoredRow?.status !== 'active') patch.starts_at = now.toISOString();
  if (subscriptionCode) patch.paystack_subscription_code = subscriptionCode;
  await admin.from('merchant_sponsored_listings').update(patch)
    .eq('id', sponsoredId)
    .in('status', ['pending_payment', 'active']);
}
