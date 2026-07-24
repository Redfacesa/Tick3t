/**
 * Inventory bounded context — consumes inventory.consume.requested.
 *
 * payment.recorded does not mutate stock directly. It requests consume;
 * this consumer claims, applies stock, and emits inventory.consumed.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { emitMerchantBusinessEvent } from './businessEvents.ts';
import {
  finalizePaymentLineItems,
  isMarketplaceCheckout,
  shouldSkipInventoryForPayment,
} from './transactionLineItems.ts';

export type InventoryConsumeInput = {
  reference: string;
  merchantId: string;
  transactionId: string;
  buyerEmail?: string | null;
  amount?: number | null;
  currency?: string | null;
  paymentSessionId?: string | null;
  metadata: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
};

export async function consumeInventoryConsumeRequested(
  admin: SupabaseClient,
  input: InventoryConsumeInput,
): Promise<{ ok: boolean; skipped?: boolean; reason?: string; linesApplied?: number }> {
  const reference = String(input.reference ?? '').trim();
  if (!reference || !input.merchantId) {
    return { ok: false, reason: 'reference_and_merchant_required' };
  }

  if (shouldSkipInventoryForPayment(input.metadata)) {
    return { ok: true, skipped: true, reason: 'inventory_not_applicable' };
  }

  const marketplace = isMarketplaceCheckout(input.metadata);
  const { data: claim, error: claimErr } = await admin.rpc('claim_inventory_consume', {
    p_reference: reference,
    p_merchant_id: input.merchantId,
    p_transaction_id: input.transactionId,
    p_marketplace: marketplace,
  });
  if (claimErr) {
    console.error('claim_inventory_consume', reference, claimErr.message);
    return { ok: false, reason: claimErr.message };
  }
  const claimRow = (claim ?? {}) as { ok?: boolean; claimed?: boolean; skipped?: boolean };
  if (claimRow.skipped || claimRow.claimed === false) {
    return { ok: true, skipped: true, reason: 'already_claimed' };
  }

  await finalizePaymentLineItems(admin, {
    reference,
    metadata: input.metadata,
    paymentSessionId: input.paymentSessionId ?? null,
    applyInventory: true,
  });

  const { count: movementCount } = await admin
    .from('stock_movements')
    .select('id', { count: 'exact', head: true })
    .eq('reason', `sale:${reference}`);
  const linesApplied = movementCount ?? 0;

  await admin.rpc('complete_inventory_consume_claim', {
    p_reference: reference,
    p_lines_applied: linesApplied,
  });

  if (linesApplied > 0) {
    await emitMerchantBusinessEvent(admin, {
      merchantId: input.merchantId,
      eventType: 'inventory.consumed',
      actorType: 'system',
      customerEmail: input.buyerEmail ?? null,
      reference,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      source: 'inventory.consume.requested',
      idempotencyKey: `inventory.consumed:${reference}`,
      payload: {
        fact_type: 'inventory.consumed',
        correlation_id: input.correlationId ?? null,
        causation_id: input.causationId ?? null,
        transaction_id: input.transactionId,
        marketplace,
        movements: linesApplied,
        // Underscore form kept in payload for dashboards that still filter inventory_consumed.
        legacy_event_type: 'inventory_consumed',
      },
    });
  }

  return { ok: true, linesApplied };
}

/** Emit request fact, then run Inventory Consumer (sync dispatch until Kernel v2). */
export async function requestAndConsumeInventory(
  admin: SupabaseClient,
  input: InventoryConsumeInput,
): Promise<{ ok: boolean; skipped?: boolean; reason?: string; linesApplied?: number }> {
  if (shouldSkipInventoryForPayment(input.metadata)) {
    return { ok: true, skipped: true, reason: 'inventory_not_applicable' };
  }

  await emitMerchantBusinessEvent(admin, {
    merchantId: input.merchantId,
    eventType: 'inventory.consume.requested',
    actorType: 'system',
    customerEmail: input.buyerEmail ?? null,
    reference: input.reference,
    amount: input.amount ?? null,
    currency: input.currency ?? null,
    source: 'payment.recorded',
    idempotencyKey: `inventory.consume.requested:${input.reference}`,
    payload: {
      fact_type: 'inventory.consume.requested',
      correlation_id: input.correlationId ?? null,
      causation_id: input.causationId ?? null,
      transaction_id: input.transactionId,
      marketplace: isMarketplaceCheckout(input.metadata),
      payment_session_id: input.paymentSessionId ?? null,
    },
  });

  return consumeInventoryConsumeRequested(admin, {
    ...input,
    causationId: input.causationId ?? `inventory.consume.requested:${input.reference}`,
  });
}
