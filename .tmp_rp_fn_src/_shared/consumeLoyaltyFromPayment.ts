/**
 * Loyalty consumer — awards points from payment.recorded (idempotent).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { emitMerchantBusinessEvent } from './businessEvents.ts';
import { resolveCheckoutMetadata } from './transactionLineItems.ts';

const NON_LOYALTY_PURCHASE_TYPES = new Set([
  'domain',
  'domain_renewal',
  'plan_subscription',
  'product_subscription',
  'developer_api_subscription',
  'sponsored_listing',
  'agency',
  'studio_subscription',
]);

export async function consumeLoyaltyFromPaymentRecorded(
  admin: SupabaseClient,
  input: {
    reference: string;
    merchantId: string;
    buyerEmail?: string | null;
    amount?: number | null;
    currency?: string | null;
    paymentSessionId?: string | null;
  },
): Promise<{ ok: boolean; skipped?: boolean; reason?: string; points?: number }> {
  const reference = String(input.reference ?? '').trim();
  const buyerEmail = String(input.buyerEmail ?? '').trim().toLowerCase();
  const amount = Number(input.amount ?? 0);
  if (!reference || !buyerEmail || !(amount > 0)) {
    return { ok: true, skipped: true, reason: 'missing_buyer_or_amount' };
  }

  const meta = await resolveCheckoutMetadata(admin, {
    reference,
    paymentSessionId: input.paymentSessionId ?? null,
  });
  const purchaseType = String(meta.purchase_type ?? meta.object_type ?? '').toLowerCase();
  if (NON_LOYALTY_PURCHASE_TYPES.has(purchaseType)) {
    return { ok: true, skipped: true, reason: 'non_loyalty_purchase' };
  }

  const { data, error } = await admin.rpc('award_loyalty_points', {
    p_merchant_id: input.merchantId,
    p_buyer_email: buyerEmail,
    p_amount: amount,
    p_reference: reference,
  });
  if (error) {
    console.error('award_loyalty_points', reference, error.message);
    return { ok: false, reason: error.message };
  }

  const row = (data ?? {}) as { ok?: boolean; awarded?: boolean; points?: number; skipped?: boolean };
  if (row.skipped || row.awarded === false) {
    return { ok: true, skipped: true, reason: 'already_awarded_or_no_program', points: 0 };
  }

  const points = Number(row.points ?? 0);
  if (points > 0) {
    await emitMerchantBusinessEvent(admin, {
      merchantId: input.merchantId,
      eventType: 'loyalty.points_awarded',
      actorType: 'system',
      customerEmail: buyerEmail,
      reference,
      amount,
      currency: input.currency ?? null,
      source: 'payment.recorded',
      idempotencyKey: `loyalty:award:${reference}`,
      payload: { points, transaction_reference: reference },
    });
  }

  return { ok: true, points };
}
