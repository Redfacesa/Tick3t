/**
 * Review + thank-you lifecycle from payment.recorded.
 * Immediate thank-you email; review invite after 24h via customer_review_requests cron.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { emitMerchantBusinessEvent } from './businessEvents.ts';

const NON_REVIEW_PURCHASE_TYPES = new Set([
  'domain',
  'domain_renewal',
  'plan_subscription',
  'product_subscription',
  'developer_api_subscription',
  'sponsored_listing',
  'agency',
  'studio_subscription',
  'bank_transfer',
]);

export async function consumeReviewLifecycleFromPaymentRecorded(
  admin: SupabaseClient,
  input: {
    reference: string;
    merchantId: string;
    buyerEmail?: string | null;
    amount?: number | null;
    currency?: string | null;
    purchaseType?: string | null;
    correlationId?: string | null;
    causationId?: string | null;
  },
): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  const reference = String(input.reference ?? '').trim();
  const buyerEmail = String(input.buyerEmail ?? '').trim().toLowerCase();
  if (!reference || !buyerEmail) {
    return { ok: true, skipped: true, reason: 'no_buyer_email' };
  }

  const purchaseType = String(input.purchaseType ?? '').toLowerCase();
  if (purchaseType && NON_REVIEW_PURCHASE_TYPES.has(purchaseType)) {
    return { ok: true, skipped: true, reason: 'non_review_purchase' };
  }

  const { data: merchant } = await admin
    .from('merchants')
    .select('business_name')
    .eq('id', input.merchantId)
    .maybeSingle();
  const merchantName = String(merchant?.business_name || 'your merchant').trim() || 'your merchant';

  const thankYouBody =
    `Hi,\n\n` +
    `Thank you for shopping with ${merchantName}.\n\n` +
    `Your payment has been received successfully. We appreciate your support.\n\n` +
    `If you need help, contact ${merchantName}.\n\n` +
    `Thank you for using RedFace Pay.`;

  await admin.rpc('enqueue_platform_notification', {
    p_channel: 'email',
    p_recipient: buyerEmail,
    p_event_type: 'purchase_thank_you',
    p_body: thankYouBody,
    p_payload: {
      reference,
      merchant_id: input.merchantId,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
    },
    p_subject: `Thank you for your purchase at ${merchantName}`,
    p_merchant_id: input.merchantId,
    p_reference: reference,
  });

  const { data: allowsReview } = await admin.rpc('customer_allows_review_requests', {
    p_merchant_id: input.merchantId,
    p_email: buyerEmail,
  });
  if (allowsReview === false) {
    return { ok: true, skipped: true, reason: 'review_requests_disabled' };
  }

  const { data: created, error } = await admin.rpc('create_review_request_from_payment', {
    p_reference: reference,
  });
  if (error) {
    console.error('create_review_request_from_payment', reference, error.message);
    return { ok: false, reason: error.message };
  }

  const row = (created ?? {}) as {
    ok?: boolean;
    skipped?: boolean;
    reason?: string;
    id?: string;
    public_token?: string;
  };

  if (row.ok && !row.skipped && row.id) {
    await emitMerchantBusinessEvent(admin, {
      merchantId: input.merchantId,
      eventType: 'review_request_queued',
      actorType: 'system',
      customerEmail: buyerEmail,
      reference,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      source: 'payment.recorded',
      idempotencyKey: `review_request_queued:${reference}`,
      payload: {
        review_request_id: row.id,
        public_token: row.public_token ?? null,
        send_after_hours: 24,
        correlation_id: input.correlationId ?? null,
        causation_id: input.causationId ?? null,
      },
    });
  }

  return { ok: true, skipped: Boolean(row.skipped), reason: row.reason };
}
