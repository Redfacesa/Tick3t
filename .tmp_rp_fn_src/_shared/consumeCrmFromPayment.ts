/**
 * CRM consumer — projects merchant_customers from payment.recorded.
 *
 * Facts → projection (not transactions trigger). Claims make it idempotent.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { emitMerchantBusinessEvent } from './businessEvents.ts';
import { resolveCheckoutMetadata } from './transactionLineItems.ts';

const NON_CRM_PURCHASE_TYPES = new Set([
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

export async function consumeCrmFromPaymentRecorded(
  admin: SupabaseClient,
  input: {
    reference: string;
    merchantId: string;
    transactionId: string;
    buyerEmail?: string | null;
    amount?: number | null;
    currency?: string | null;
    paymentSessionId?: string | null;
    businessIntent?: string | null;
    processingRail?: string | null;
    correlationId?: string | null;
    causationId?: string | null;
  },
): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  const reference = String(input.reference ?? '').trim();
  const buyerEmail = String(input.buyerEmail ?? '').trim().toLowerCase();
  if (!reference || !buyerEmail) {
    return { ok: true, skipped: true, reason: 'no_buyer_email' };
  }

  const meta = await resolveCheckoutMetadata(admin, {
    reference,
    paymentSessionId: input.paymentSessionId ?? null,
  });
  const purchaseType = String(meta.purchase_type ?? meta.object_type ?? '').toLowerCase();
  if (NON_CRM_PURCHASE_TYPES.has(purchaseType)) {
    return { ok: true, skipped: true, reason: 'non_crm_purchase' };
  }

  // Projection first: merchant_customers is rebuilt from facts, not the trigger.
  const { data: projected, error: projErr } = await admin.rpc(
    'project_merchant_customer_from_payment',
    { p_reference: reference },
  );
  if (projErr) {
    console.error('project_merchant_customer_from_payment', reference, projErr.message);
    return { ok: false, reason: projErr.message };
  }
  const proj = (projected ?? {}) as { ok?: boolean; projected?: boolean; customer_id?: string };

  const { data: lineItems } = await admin
    .from('transaction_line_items')
    .select('product_id, name, quantity, line_total')
    .eq('transaction_id', input.transactionId)
    .order('sort_order');

  const productSummary = (lineItems ?? [])
    .filter((l) => l.product_id)
    .map((l) => ({
      product_id: l.product_id,
      name: l.name,
      quantity: l.quantity,
      line_total: l.line_total,
    }));

  const { count: priorCount } = await admin
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_id', input.merchantId)
    .eq('status', 'success')
    .ilike('buyer_email', buyerEmail)
    .neq('id', input.transactionId)
    .gte('created_at', new Date(Date.now() - 365 * 86400000).toISOString());

  const envelopeMeta = {
    correlation_id: input.correlationId ?? null,
    causation_id: input.causationId ?? null,
  };

  await emitMerchantBusinessEvent(admin, {
    merchantId: input.merchantId,
    eventType: 'customer_purchase_recorded',
    actorType: 'buyer',
    customerEmail: buyerEmail,
    reference,
    amount: input.amount ?? null,
    currency: input.currency ?? null,
    source: 'payment.recorded',
    idempotencyKey: `crm:purchase:${reference}`,
    payload: {
      ...envelopeMeta,
      fact_type: 'customer.purchase_recorded',
      transaction_id: input.transactionId,
      customer_id: proj.customer_id ?? null,
      business_intent: input.businessIntent ?? null,
      processing_rail: input.processingRail ?? null,
      product_count: productSummary.length,
      products: productSummary.slice(0, 20),
      prior_purchases_12mo: priorCount ?? 0,
      projection_created: proj.projected === true,
    },
  });

  if ((priorCount ?? 0) > 0) {
    await emitMerchantBusinessEvent(admin, {
      merchantId: input.merchantId,
      eventType: 'customer_returned',
      actorType: 'buyer',
      customerEmail: buyerEmail,
      reference,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      source: 'payment.recorded',
      idempotencyKey: `crm:returned:${reference}`,
      payload: {
        ...envelopeMeta,
        fact_type: 'customer.returned',
        prior_purchases: priorCount,
        transaction_id: input.transactionId,
      },
    });
  }

  return { ok: true };
}
