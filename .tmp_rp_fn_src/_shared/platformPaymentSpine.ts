import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function paystackWebhookEventKey(
  eventType: string,
  reference: string,
  data: Record<string, unknown>,
): string {
  const ref = reference || String(data.id ?? data.transaction_reference ?? '');
  if (ref) return `${eventType}:${ref}`;
  return `${eventType}:${crypto.randomUUID()}`;
}

/** Claim outcome — `error` means dedup could not be verified; caller must not process. */
export type WebhookClaimResult = 'claimed' | 'duplicate' | 'error';

export async function claimPaystackWebhook(
  admin: SupabaseClient,
  eventType: string,
  reference: string,
  data: Record<string, unknown>,
  rawPayload: unknown,
): Promise<WebhookClaimResult> {
  const eventKey = paystackWebhookEventKey(eventType, reference, data);
  const { data: claimed, error } = await admin.rpc('claim_platform_webhook_event', {
    p_event_key: eventKey,
    p_event_type: eventType,
    p_reference: reference || null,
    p_payload: rawPayload ?? {},
    p_provider: 'paystack',
  });
  if (error) {
    console.error('claim_platform_webhook_event', error.message);
    return 'error';
  }
  return claimed === false ? 'duplicate' : 'claimed';
}

/**
 * Record how webhook processing ended so every event is traceable
 * (admin reconciliation surfaces `failed` rows for replay).
 */
export async function markWebhookResult(
  admin: SupabaseClient,
  eventKey: string,
  status: 'processed' | 'failed',
  opts: { error?: string; startedAt?: number } = {},
): Promise<void> {
  const { error } = await admin.rpc('mark_platform_webhook_result', {
    p_event_key: eventKey,
    p_status: status,
    p_error: opts.error ?? null,
    p_ms: opts.startedAt ? Math.round(Date.now() - opts.startedAt) : null,
  });
  if (error) console.error('mark_platform_webhook_result', error.message);
}

export type AppendPaymentEventOpts = {
  eventType: string;
  reference?: string | null;
  idempotencyKey?: string | null;
  app?: string | null;
  merchantId?: string | null;
  userId?: string | null;
  amount?: number | null;
  currency?: string | null;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
  eventVersion?: number | null;
  producer?: string | null;
};

export async function appendPlatformPaymentEvent(
  admin: SupabaseClient,
  opts: AppendPaymentEventOpts,
): Promise<string | null> {
  const args: Record<string, unknown> = {
    p_event_type: opts.eventType,
    p_reference: opts.reference ?? null,
    p_idempotency_key: opts.idempotencyKey ?? null,
    p_app: opts.app ?? null,
    p_merchant_id: opts.merchantId ?? null,
    p_user_id: opts.userId ?? null,
    p_amount: opts.amount ?? null,
    p_currency: opts.currency ?? null,
    p_payload: opts.payload ?? {},
    p_correlation_id: opts.correlationId ?? null,
    p_causation_id: opts.causationId ?? null,
    p_event_version: opts.eventVersion ?? 1,
    p_producer: opts.producer ?? null,
  };
  const { data, error } = await admin.rpc('append_platform_payment_event', args);
  if (error) {
    // Older overload without envelope columns.
    const { data: legacy, error: legacyErr } = await admin.rpc('append_platform_payment_event', {
      p_event_type: opts.eventType,
      p_reference: opts.reference ?? null,
      p_idempotency_key: opts.idempotencyKey ?? null,
      p_app: opts.app ?? null,
      p_merchant_id: opts.merchantId ?? null,
      p_user_id: opts.userId ?? null,
      p_amount: opts.amount ?? null,
      p_currency: opts.currency ?? null,
      p_payload: {
        ...(opts.payload ?? {}),
        _envelope: {
          correlation_id: opts.correlationId ?? null,
          causation_id: opts.causationId ?? null,
          version: opts.eventVersion ?? 1,
          producer: opts.producer ?? null,
        },
      },
    });
    if (legacyErr) {
      console.error('append_platform_payment_event', opts.eventType, legacyErr.message);
      return null;
    }
    return typeof legacy === 'string' ? legacy : null;
  }
  return typeof data === 'string' ? data : null;
}

export function resolveAppFromMetadata(metadata: Record<string, unknown>): string | null {
  const agency = String(metadata.app ?? '').toLowerCase();
  if (agency === 'agency') return 'agency';
  const eco = String(metadata.ecosystem_app ?? '').toLowerCase();
  if (eco) return eco;
  const purchase = String(metadata.purchase_type ?? '').toLowerCase();
  if (purchase === 'plan_subscription') return 'pay';
  if (purchase === 'studio_subscription') return 'studio';
  if (agency === 'studio') return 'studio';
  return null;
}
