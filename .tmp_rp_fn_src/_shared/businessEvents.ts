import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type EmitBusinessEventOpts = {
  merchantId: string;
  eventType: string;
  actorType?: 'buyer' | 'merchant' | 'system';
  actorUserId?: string | null;
  customerEmail?: string | null;
  productId?: string | null;
  reference?: string | null;
  amount?: number | null;
  currency?: string | null;
  source?: string | null;
  idempotencyKey?: string | null;
  payload?: Record<string, unknown>;
};

export async function emitMerchantBusinessEvent(
  admin: SupabaseClient,
  opts: EmitBusinessEventOpts,
): Promise<void> {
  const { error } = await admin.rpc('append_merchant_business_event', {
    p_merchant_id: opts.merchantId,
    p_event_type: opts.eventType,
    p_actor_type: opts.actorType ?? 'system',
    p_actor_user_id: opts.actorUserId ?? null,
    p_customer_email: opts.customerEmail ?? null,
    p_product_id: opts.productId ?? null,
    p_reference: opts.reference ?? null,
    p_amount: opts.amount ?? null,
    p_currency: opts.currency ?? null,
    p_source: opts.source ?? 'edge',
    p_idempotency_key: opts.idempotencyKey ?? null,
    p_payload: opts.payload ?? {},
  });
  if (error) console.error('append_merchant_business_event', opts.eventType, error.message);
}
