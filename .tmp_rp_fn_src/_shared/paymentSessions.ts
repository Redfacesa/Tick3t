/** Payment Session helpers — terminal mode (merchant Ready → customer tap). */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { cartLabel, resolveCartItems, type CartLine } from './cartItems.ts';
import {
  claimPaymentRequest,
  completePaymentRequest,
  idempotentSessionMessage,
} from './idempotency.ts';
import { recordPaymentLedgerEntry } from './ledgerEngine.ts';
import { selectProcessingRail, routingDecisionToMeta } from './paymentRouting.ts';

export type { CartLine };
export { cartLabel, resolveCartItems };

const ACTIVE_SESSION_STATUSES = new Set(['waiting', 'opened', 'processing']);

export function isActivePaymentSessionStatus(status: string): boolean {
  return ACTIVE_SESSION_STATUSES.has(status);
}

export type PaymentSessionRow = {
  id: string;
  merchant_id: string;
  payment_object_id: string | null;
  public_token: string;
  amount: number;
  currency: string;
  label: string | null;
  status: string;
  expires_at: string;
  metadata?: Record<string, unknown> | null;
};

export async function cancelOpenSessions(
  admin: SupabaseClient,
  merchantId: string,
  paymentObjectId: string | null,
) {
  let q = admin
    .from('payment_sessions')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('merchant_id', merchantId)
    .in('status', ['waiting', 'opened', 'processing']);
  if (paymentObjectId) {
    q = q.eq('payment_object_id', paymentObjectId);
  } else {
    q = q.is('payment_object_id', null);
  }
  await q;
}

export async function validatePaymentSessionForInit(
  admin: SupabaseClient,
  opts: {
    sessionId?: string | null;
    sessionToken?: string | null;
    merchantId: string;
    amount: number;
    reference: string;
  },
): Promise<{ ok: true; session: PaymentSessionRow } | { ok: false; message: string }> {
  const { sessionId, sessionToken, merchantId, amount, reference } = opts;
  if (!sessionId && !sessionToken) {
    return { ok: false, message: 'payment_session required' };
  }

  await admin.rpc('expire_payment_sessions').then(() => {}, () => {});

  let q = admin
    .from('payment_sessions')
    .select('id, merchant_id, payment_object_id, public_token, amount, currency, label, status, expires_at')
    .eq('merchant_id', merchantId)
    .in('status', ['waiting', 'opened', 'processing'])
    .gt('expires_at', new Date().toISOString());

  if (sessionId) q = q.eq('id', sessionId);
  else if (sessionToken) q = q.eq('public_token', sessionToken);
  else return { ok: false, message: 'payment_session required' };

  const { data: session, error } = await q.maybeSingle();
  if (error || !session) {
    return { ok: false, message: 'Payment session not found or expired. Ask the merchant to press Ready again.' };
  }

  const sessionAmount = Number(session.amount);
  if (Math.abs(sessionAmount - amount) > 0.009) {
    return {
      ok: false,
      message: `Amount must match the merchant session (${sessionAmount} ${session.currency}).`,
    };
  }

  await admin.rpc('mark_payment_session_processing', {
    p_session_id: session.id,
    p_reference: reference,
  });

  return { ok: true, session: session as PaymentSessionRow };
}

export async function markSessionPaid(
  admin: SupabaseClient,
  reference: string,
  transactionId?: string | null,
) {
  await admin.rpc('mark_payment_session_paid', {
    p_reference: reference,
    p_transaction_id: transactionId ?? null,
  });
  // Ledger commitment: providers are evidence, the Ledger is truth.
  // Idempotent — duplicate webhooks and sync/async races collapse into one entry.
  await recordPaymentLedgerEntry(admin, { reference });
}

export async function markSessionFailed(admin: SupabaseClient, reference: string) {
  await admin.rpc('mark_payment_session_failed', { p_reference: reference });
}

export async function reopenPaymentSession(admin: SupabaseClient, sessionId: string) {
  await admin.rpc('mark_payment_session_reopen', { p_session_id: sessionId });
}

const SESSION_SELECT =
  'id, public_token, amount, currency, label, status, expires_at, payment_object_id, cart_items';

export async function createPaymentSessionRecord(
  admin: SupabaseClient,
  opts: {
    merchantId: string;
    amount?: number;
    currency?: string;
    label?: string | null;
    paymentObjectId?: string | null;
    ttlSeconds?: number;
    cartItems?: unknown;
    createdBy?: string | null;
    idempotencyKey?: string | null;
    requestType?: 'payment_session' | 'table_pay';
    metadata?: Record<string, unknown> | null;
    /** WHAT the merchant wants to achieve (never a provider). Defaults to collect_payment. */
    businessIntent?: string | null;
    /** HOW the customer will authorise, when known at creation (qr, nfc_tap, table_pay, ...). */
    captureMethod?: string | null;
    /** Merchant operating country for Routing Engine (ISO 3166-1 alpha-2). */
    country?: string | null;
    softposPartner?: 'istore_tap' | 'yoco_tap' | 'stripe_terminal' | null;
    stripeTerminalEntitled?: boolean;
  },
): Promise<
  | {
    ok: true;
    session: Record<string, unknown>;
    cartItems: CartLine[];
    idempotent?: boolean;
    retryCount?: number;
    message?: string | null;
  }
  | { ok: false; error: string; status?: number }
> {
  let amount = Number(opts.amount ?? 0);
  const currency = String(opts.currency ?? 'ZAR').trim() || 'ZAR';
  let label = String(opts.label ?? '').trim() || null;
  let paymentObjectId = String(opts.paymentObjectId ?? '').trim() || null;
  const ttlSeconds = Math.min(3600, Math.max(60, Number(opts.ttlSeconds ?? 900)));
  let cartItemsStored: CartLine[] = [];

  if (opts.cartItems != null && Array.isArray(opts.cartItems) && opts.cartItems.length > 0) {
    const resolved = await resolveCartItems(admin, opts.merchantId, opts.cartItems);
    if ('error' in resolved) return { ok: false, error: resolved.error, status: 400 };
    amount = resolved.total;
    cartItemsStored = resolved.items;
  }

  if (!amount || amount <= 0) {
    return { ok: false, error: 'amount is required', status: 400 };
  }

  const idempotencyKey = String(opts.idempotencyKey ?? '').trim() || null;
  const requestType = opts.requestType ?? 'payment_session';

  if (idempotencyKey) {
    const claim = await claimPaymentRequest(admin, {
      merchantId: opts.merchantId,
      idempotencyKey,
      requestType,
      amount,
      currency,
      requestPayload: {
        label,
        payment_object_id: paymentObjectId,
        cart_count: cartItemsStored.length,
      },
    });
    if (claim.ok && !claim.created && claim.request.payment_session_id) {
      const { data: existing } = await admin
        .from('payment_sessions')
        .select(SESSION_SELECT)
        .eq('id', claim.request.payment_session_id)
        .eq('merchant_id', opts.merchantId)
        .maybeSingle();
      if (existing) {
        const storedCart = Array.isArray(existing.cart_items) ? existing.cart_items as CartLine[] : cartItemsStored;
        if (isActivePaymentSessionStatus(String(existing.status))) {
          return {
            ok: true,
            session: existing,
            cartItems: storedCart,
            idempotent: true,
            retryCount: claim.retryCount,
            message: idempotentSessionMessage(String(existing.status)),
          };
        }
        // Stale idempotency (paid / expired / cancelled) — create a fresh session below.
      }
    }
  }

  if (!paymentObjectId) {
    const { data: primary } = await admin
      .from('payment_objects')
      .select('id')
      .eq('merchant_id', opts.merchantId)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    paymentObjectId = primary?.id ?? null;
  }

  let terminalLabel: string | null = null;
  let terminalTapCode: string | null = null;
  if (paymentObjectId) {
    const { data: obj } = await admin
      .from('payment_objects')
      .select('id, label, tap_code')
      .eq('id', paymentObjectId)
      .eq('merchant_id', opts.merchantId)
      .eq('status', 'active')
      .maybeSingle();
    if (!obj) return { ok: false, error: 'Terminal not found', status: 404 };
    terminalLabel = obj.label ? String(obj.label) : null;
    terminalTapCode = obj.tap_code ? String(obj.tap_code) : null;
  }

  await admin.rpc('expire_payment_sessions').then(() => {}, () => {});
  await cancelOpenSessions(admin, opts.merchantId, paymentObjectId);

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const rawMetadata = opts.metadata && typeof opts.metadata === 'object'
    ? opts.metadata
    : {};
  // Commerce Intelligence: every session carries enough business context to
  // explain who / what / where — notes are never the only source of truth.
  const sessionMetadata: Record<string, unknown> = {
    ...rawMetadata,
  };
  if (paymentObjectId) {
    sessionMetadata.payment_object_id = paymentObjectId;
    if (terminalLabel) sessionMetadata.terminal_label = terminalLabel;
    if (terminalTapCode) sessionMetadata.terminal_tap_code = terminalTapCode;
  }
  if (cartItemsStored.length) {
    sessionMetadata.line_item_count = cartItemsStored.length;
    sessionMetadata.has_line_items = true;
  }
  const hasPosSale = Boolean(String(sessionMetadata.pos_sale_id ?? '').trim());
  const hasCart = cartItemsStored.length > 0;
  const businessIntent = String(opts.businessIntent ?? '').trim().toLowerCase()
    || (requestType === 'table_pay' || hasPosSale || hasCart ? 'complete_sale' : 'collect_payment');
  let captureMethod = String(opts.captureMethod ?? '').trim().toLowerCase() || null;
  if (!captureMethod) {
    if (requestType === 'table_pay') captureMethod = 'table_pay';
    else if (paymentObjectId) captureMethod = 'nfc_tap';
    else if (hasPosSale) captureMethod = 'checkout';
    else captureMethod = 'payment_link';
  }
  sessionMetadata.business_intent = businessIntent;
  sessionMetadata.capture_method = captureMethod;
  const routing = selectProcessingRail({
    merchantId: opts.merchantId,
    currency,
    country: opts.country ?? null,
    captureMethod,
    businessIntent,
    softposPartner: opts.softposPartner ?? null,
    stripeTerminalEntitled: opts.stripeTerminalEntitled,
  });
  sessionMetadata.routing = routingDecisionToMeta(routing);
  sessionMetadata.processing_rail = routing.rail;
  const { data: row, error } = await admin.from('payment_sessions').insert({
    merchant_id: opts.merchantId,
    payment_object_id: paymentObjectId,
    amount,
    currency,
    label: label || (cartItemsStored.length ? cartLabel(cartItemsStored) : null),
    cart_items: cartItemsStored,
    metadata: sessionMetadata,
    status: 'waiting',
    expires_at: expiresAt,
    created_by: opts.createdBy ?? null,
    business_intent: businessIntent,
    capture_method: captureMethod,
    processing_rail: routing.rail,
  }).select(SESSION_SELECT).single();

  if (error || !row) {
    return { ok: false, error: error?.message || 'Could not create payment session', status: 500 };
  }

  if (idempotencyKey) {
    await completePaymentRequest(admin, {
      merchantId: opts.merchantId,
      idempotencyKey,
      requestType,
      status: 'processing',
      paymentSessionId: String(row.id),
      responsePayload: { session: row },
    });
  }

  return { ok: true, session: row, cartItems: cartItemsStored, idempotent: false, retryCount: 0 };
}
