/** RedFace Core Payment Engine — idempotency for all money-moving operations. */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type PaymentRequestType =
  | 'payment_session'
  | 'checkout'
  | 'refund'
  | 'refund_process'
  | 'quote_accept'
  | 'table_pay'
  | 'subscription'
  | 'store_credit';

export type PaymentRequestRow = {
  id: string;
  idempotency_key: string;
  merchant_id: string;
  request_type: string;
  status: string;
  customer_email: string | null;
  payment_session_id: string | null;
  transaction_reference: string | null;
  amount: number | null;
  currency: string | null;
  request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown>;
  retry_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type CheckoutIdentity = {
  reference: string;
  idempotencyKey: string;
  reused: boolean;
  alreadyPaid: boolean;
  retryCount: number;
  cachedResponse: Record<string, unknown> | null;
};

export function readIdempotencyKey(req: Request, body: Record<string, unknown>): string | null {
  const header = req.headers.get('Idempotency-Key')?.trim()
    || req.headers.get('X-Idempotency-Key')?.trim()
    || '';
  const bodyKey = String(body.idempotency_key ?? '').trim();
  return header || bodyKey || null;
}

export function ensureIdempotencyKey(existing: string | null | undefined): string {
  if (existing?.trim()) return existing.trim();
  return `rf_${crypto.randomUUID()}`;
}

export async function claimPaymentRequest(
  admin: SupabaseClient,
  opts: {
    merchantId: string;
    idempotencyKey: string;
    requestType: PaymentRequestType;
    customerEmail?: string | null;
    amount?: number | null;
    currency?: string | null;
    requestPayload?: Record<string, unknown>;
  },
): Promise<
  | { ok: true; created: boolean; retryCount: number; request: PaymentRequestRow }
  | { ok: false; error: string }
> {
  const { data, error } = await admin.rpc('claim_payment_request', {
    p_merchant_id: opts.merchantId,
    p_idempotency_key: opts.idempotencyKey,
    p_request_type: opts.requestType,
    p_customer_email: opts.customerEmail ?? null,
    p_amount: opts.amount ?? null,
    p_currency: opts.currency ?? null,
    p_request_payload: opts.requestPayload ?? {},
  });
  if (error) return { ok: false, error: error.message };
  const payload = data as {
    ok?: boolean;
    error?: string;
    created?: boolean;
    retry_count?: number;
    request?: PaymentRequestRow;
  };
  if (!payload?.ok || !payload.request) {
    return { ok: false, error: payload?.error ?? 'claim_failed' };
  }
  return {
    ok: true,
    created: !!payload.created,
    retryCount: Number(payload.retry_count ?? 0),
    request: payload.request,
  };
}

export async function completePaymentRequest(
  admin: SupabaseClient,
  opts: {
    merchantId: string;
    idempotencyKey: string;
    requestType: PaymentRequestType;
    status?: 'pending' | 'processing' | 'completed' | 'failed';
    paymentSessionId?: string | null;
    transactionReference?: string | null;
    responsePayload?: Record<string, unknown>;
  },
): Promise<void> {
  await admin.rpc('complete_payment_request', {
    p_merchant_id: opts.merchantId,
    p_idempotency_key: opts.idempotencyKey,
    p_request_type: opts.requestType,
    p_status: opts.status ?? 'completed',
    p_payment_session_id: opts.paymentSessionId ?? null,
    p_transaction_reference: opts.transactionReference ?? null,
    p_response_payload: opts.responsePayload ?? {},
  });
}

export async function getPaymentRequest(
  admin: SupabaseClient,
  merchantId: string,
  idempotencyKey: string,
  requestType?: PaymentRequestType,
): Promise<PaymentRequestRow | null> {
  const { data } = await admin.rpc('get_payment_request_by_idempotency', {
    p_merchant_id: merchantId,
    p_idempotency_key: idempotencyKey,
    p_request_type: requestType ?? null,
  });
  if (!data || typeof data !== 'object') return null;
  return data as PaymentRequestRow;
}

export async function resolveCheckoutIdentity(
  admin: SupabaseClient,
  req: Request,
  body: Record<string, unknown>,
  merchantId: string,
): Promise<CheckoutIdentity> {
  const idempotencyKey = ensureIdempotencyKey(readIdempotencyKey(req, body));

  const existingRequest = await getPaymentRequest(admin, merchantId, idempotencyKey, 'checkout');
  if (existingRequest?.status === 'completed' && existingRequest.response_payload) {
    const cached = existingRequest.response_payload;
    if (cached.already_paid || cached.authorization_url) {
      return {
        reference: String(existingRequest.transaction_reference ?? cached.reference ?? ''),
        idempotencyKey,
        reused: true,
        alreadyPaid: !!cached.already_paid,
        retryCount: existingRequest.retry_count,
        cachedResponse: cached,
      };
    }
  }

  const { data: existingRef } = await admin.rpc('get_payment_reference_by_idempotency', {
    p_key: idempotencyKey,
  });

  if (existingRef) {
    const { data: txn } = await admin
      .from('transactions')
      .select('status, reference')
      .eq('reference', existingRef)
      .maybeSingle();
    if (txn?.status === 'success') {
      await claimPaymentRequest(admin, {
        merchantId,
        idempotencyKey,
        requestType: 'checkout',
        customerEmail: String(body.email ?? '').trim() || null,
      });
      return {
        reference: String(existingRef),
        idempotencyKey,
        reused: true,
        alreadyPaid: true,
        retryCount: (existingRequest?.retry_count ?? 0) + 1,
        cachedResponse: { already_paid: true, reference: existingRef },
      };
    }
    if (txn?.status === 'pending') {
      const claim = await claimPaymentRequest(admin, {
        merchantId,
        idempotencyKey,
        requestType: 'checkout',
        customerEmail: String(body.email ?? '').trim() || null,
        amount: body.amount != null ? Number(body.amount) : null,
        currency: String(body.currency ?? 'ZAR'),
        requestPayload: { source: 'init_payment' },
      });
      return {
        reference: String(existingRef),
        idempotencyKey,
        reused: true,
        alreadyPaid: false,
        retryCount: claim.ok ? claim.retryCount : 0,
        cachedResponse: existingRequest?.response_payload ?? null,
      };
    }
  }

  await claimPaymentRequest(admin, {
    merchantId,
    idempotencyKey,
    requestType: 'checkout',
    customerEmail: String(body.email ?? '').trim() || null,
    amount: body.amount != null ? Number(body.amount) : null,
    currency: String(body.currency ?? 'ZAR'),
    requestPayload: { source: 'init_payment' },
  });

  return {
    reference: `rfp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    idempotencyKey,
    reused: false,
    alreadyPaid: false,
    retryCount: 0,
    cachedResponse: null,
  };
}

export function idempotentSessionMessage(status: string): string | null {
  switch (status) {
    case 'waiting':
    case 'opened':
    case 'processing':
      return 'Payment already started. Waiting for customer…';
    case 'paid':
      return 'Payment already received.';
    case 'expired':
      return 'Previous payment session expired.';
    case 'cancelled':
      return 'Previous payment session was cancelled.';
    default:
      return null;
  }
}

/** Return cached response when an idempotent request already completed. */
export async function tryResumeCompletedRequest(
  admin: SupabaseClient,
  merchantId: string,
  idempotencyKey: string,
  requestType: PaymentRequestType,
  requestPayload?: Record<string, unknown>,
): Promise<
  | { hit: true; payload: Record<string, unknown>; retryCount: number }
  | { hit: false; retryCount: number }
> {
  const claim = await claimPaymentRequest(admin, {
    merchantId,
    idempotencyKey,
    requestType,
    requestPayload,
  });
  if (!claim.ok) return { hit: false, retryCount: 0 };

  const payload = claim.request.response_payload ?? {};
  const hasPayload = Object.keys(payload).length > 0;
  if (!claim.created && claim.request.status === 'completed' && hasPayload) {
    return { hit: true, payload, retryCount: claim.retryCount };
  }
  return { hit: false, retryCount: claim.retryCount };
}
