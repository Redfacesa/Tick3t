/**
 * Business modules consume Business Facts — not provider APIs (Invariant XI).
 *
 * Called once per newly committed ledger payment (`payment.recorded`).
 * Inventory runs as its own bounded context:
 *   payment.recorded → inventory.consume.requested → inventory.consumed
 * CRM and loyalty remain direct consumers until they follow the same pattern.
 * POS cash/walk-in sales without payment.recorded stay on their own path.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { emitMerchantBusinessEvent } from './businessEvents.ts';
import { completePosSplitCardTender, posSaleIdFromMetadata } from './posSplitTender.ts';
import {
  isMarketplaceCheckout,
  resolveCheckoutMetadata,
  shouldSkipInventoryForPayment,
} from './transactionLineItems.ts';
import { requestAndConsumeInventory } from './consumeInventoryFromPayment.ts';
import { consumeCrmFromPaymentRecorded } from './consumeCrmFromPayment.ts';
import { consumeLoyaltyFromPaymentRecorded } from './consumeLoyaltyFromPayment.ts';
import { consumeReviewLifecycleFromPaymentRecorded } from './consumeReviewLifecycleFromPayment.ts';

export type PaymentRecordedContext = {
  reference: string;
  merchantId?: string | null;
  amount?: number | null;
  currency?: string | null;
  businessIntent?: string | null;
  processingRail?: string | null;
  txnKey?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
};

export async function consumePaymentRecorded(
  admin: SupabaseClient,
  ctx: PaymentRecordedContext,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const reference = String(ctx.reference ?? '').trim();
  if (!reference) return { ok: false, error: 'reference_required' };

  const { data: txn, error: txnErr } = await admin
    .from('transactions')
    .select('id, merchant_id, amount, currency, buyer_email, payment_session_id, status')
    .eq('reference', reference)
    .maybeSingle();
  if (txnErr || !txn) return { ok: false, error: txnErr?.message ?? 'transaction_not_found' };
  if (txn.status !== 'success') return { ok: true, skipped: true };

  let sessionMeta: Record<string, unknown> = {};
  let captureMethod: string | null = null;
  let businessIntent = ctx.businessIntent ?? null;

  if (txn.payment_session_id) {
    const { data: sess } = await admin
      .from('payment_sessions')
      .select('metadata, business_intent, capture_method, processing_rail')
      .eq('id', txn.payment_session_id)
      .maybeSingle();
    if (sess) {
      sessionMeta = (sess.metadata && typeof sess.metadata === 'object')
        ? sess.metadata as Record<string, unknown>
        : {};
      captureMethod = sess.capture_method ?? null;
      businessIntent = businessIntent ?? sess.business_intent ?? null;
    }
  }

  const posSaleId = posSaleIdFromMetadata(sessionMeta);
  const merchantId = String(ctx.merchantId ?? txn.merchant_id ?? '');
  if (!merchantId) return { ok: false, error: 'merchant_id_required' };

  if (posSaleId) {
    const splitDone = await completePosSplitCardTender(
      admin,
      posSaleId,
      reference,
      txn.id,
    );
    if (!splitDone.ok) {
      console.error('consumePaymentRecorded pos_card_tender', reference, posSaleId, splitDone.error);
      return { ok: false, error: splitDone.error ?? 'pos_card_tender_failed' };
    }

    await emitMerchantBusinessEvent(admin, {
      merchantId,
      eventType: 'pos_card_settled',
      actorType: 'system',
      customerEmail: txn.buyer_email ?? null,
      reference,
      amount: Number(ctx.amount ?? txn.amount ?? 0) || null,
      currency: ctx.currency ?? txn.currency ?? null,
      source: 'payment.recorded',
      idempotencyKey: `pos_card_settled:${reference}`,
      payload: {
        pos_sale_id: posSaleId,
        business_intent: businessIntent,
        capture_method: captureMethod,
        processing_rail: ctx.processingRail ?? null,
        txn_key: ctx.txnKey ?? null,
        transaction_id: txn.id,
      },
    });
  }

  const checkoutMeta = await resolveCheckoutMetadata(admin, {
    reference,
    paymentSessionId: txn.payment_session_id,
    sessionMeta,
  });

  if (!shouldSkipInventoryForPayment(checkoutMeta)) {
    const inv = await requestAndConsumeInventory(admin, {
      reference,
      merchantId,
      transactionId: txn.id,
      buyerEmail: txn.buyer_email,
      amount: Number(ctx.amount ?? txn.amount ?? 0) || null,
      currency: ctx.currency ?? txn.currency ?? null,
      paymentSessionId: txn.payment_session_id,
      metadata: checkoutMeta,
      correlationId: ctx.correlationId ?? null,
      causationId: ctx.causationId ?? null,
    });
    if (!inv.ok) {
      console.error('consumePaymentRecorded inventory', reference, inv.reason);
    }
  }

  await consumeCrmFromPaymentRecorded(admin, {
    reference,
    merchantId,
    transactionId: txn.id,
    buyerEmail: txn.buyer_email,
    amount: Number(ctx.amount ?? txn.amount ?? 0) || null,
    currency: ctx.currency ?? txn.currency ?? null,
    paymentSessionId: txn.payment_session_id,
    businessIntent: businessIntent ?? ctx.businessIntent ?? null,
    processingRail: ctx.processingRail ?? null,
    correlationId: ctx.correlationId ?? null,
    causationId: ctx.causationId ?? null,
  });

  // Multi-vendor marketplace loyalty stays in fan-out (per seller subtotal).
  if (!isMarketplaceCheckout(checkoutMeta)) {
    await consumeLoyaltyFromPaymentRecorded(admin, {
      reference,
      merchantId,
      buyerEmail: txn.buyer_email,
      amount: Number(ctx.amount ?? txn.amount ?? 0) || null,
      currency: ctx.currency ?? txn.currency ?? null,
      paymentSessionId: txn.payment_session_id,
    });
  }

  const purchaseType = String(
    checkoutMeta.purchase_type ?? checkoutMeta.object_type ?? '',
  ).toLowerCase();
  await consumeReviewLifecycleFromPaymentRecorded(admin, {
    reference,
    merchantId,
    buyerEmail: txn.buyer_email,
    amount: Number(ctx.amount ?? txn.amount ?? 0) || null,
    currency: ctx.currency ?? txn.currency ?? null,
    purchaseType,
    correlationId: ctx.correlationId ?? null,
    causationId: ctx.causationId ?? null,
  });

  return { ok: true };
}
