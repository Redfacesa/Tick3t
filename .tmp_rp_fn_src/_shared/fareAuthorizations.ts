/** Fare authorization — Takasit / mobility authorize-on-board, capture-on-complete. */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  capturePaystackPreauthorization,
  releasePaystackPreauthorization,
} from './paystackApi.ts';

export type FareAuthRow = {
  id: string;
  merchant_id: string;
  reservation_id: string | null;
  amount_zar: number;
  captured_amount_zar: number | null;
  currency: string;
  label: string | null;
  status: string;
  payment_method: string | null;
  paystack_reference: string | null;
  paystack_preauth_reference: string | null;
  paystack_authorization_code: string | null;
  buyer_email: string | null;
  capture_reference: string | null;
  transaction_id: string | null;
  metadata: Record<string, unknown>;
};

export function buildFarePreauthReference(authorizationId: string): string {
  return `RFPR-${authorizationId.replace(/-/g, '').slice(0, 24)}`;
}

export async function createFareAuthorization(
  admin: SupabaseClient,
  opts: {
    merchantId: string;
    amountZar: number;
    currency?: string;
    label?: string;
    reservationId?: string;
    paymentMethod?: string;
    buyerEmail?: string;
    status?: string;
    paystackPreauthReference?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ ok: true; row: FareAuthRow } | { ok: false; message: string }> {
  const { data: merchant } = await admin
    .from('merchants')
    .select('id, status')
    .eq('id', opts.merchantId)
    .maybeSingle();

  if (!merchant || merchant.status !== 'approved') {
    return { ok: false, message: 'Merchant not found or not approved' };
  }

  const amount = Number(opts.amountZar);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: 'amount must be greater than zero' };
  }

  const { data, error } = await admin
    .from('fare_authorizations')
    .insert({
      merchant_id: opts.merchantId,
      reservation_id: opts.reservationId?.trim() || null,
      amount_zar: amount,
      currency: opts.currency ?? 'ZAR',
      label: opts.label?.trim() || null,
      payment_method: opts.paymentMethod ?? 'redface',
      buyer_email: opts.buyerEmail?.trim().toLowerCase() || null,
      status: opts.status ?? 'authorized',
      paystack_preauth_reference: opts.paystackPreauthReference ?? null,
      metadata: {
        source: 'takasit',
        ...(opts.metadata ?? {}),
      },
    })
    .select()
    .single();

  if (error || !data) {
    return { ok: false, message: error?.message ?? 'Could not create authorization' };
  }

  return { ok: true, row: data as FareAuthRow };
}

export async function markFarePreauthReserved(
  admin: SupabaseClient,
  reference: string,
  patch: {
    authorizationCode?: string | null;
    buyerEmail?: string | null;
    fareAuthorizationId?: string | null;
  } = {},
): Promise<FareAuthRow | null> {
  const now = new Date().toISOString();
  const update = {
    status: 'authorized',
    paystack_preauth_reference: reference,
    paystack_reference: reference,
    paystack_authorization_code: patch.authorizationCode ?? null,
    buyer_email: patch.buyerEmail ?? null,
    authorized_at: now,
    updated_at: now,
  };

  const { data } = await admin
    .from('fare_authorizations')
    .update(update)
    .eq('paystack_preauth_reference', reference)
    .in('status', ['pending_preauth', 'authorized'])
    .select()
    .maybeSingle();

  if (data) return data as FareAuthRow;

  if (patch.fareAuthorizationId) {
    const { data: byId } = await admin
      .from('fare_authorizations')
      .update(update)
      .eq('id', patch.fareAuthorizationId)
      .in('status', ['pending_preauth', 'authorized'])
      .select()
      .maybeSingle();
    return (byId as FareAuthRow) ?? null;
  }

  return null;
}

export async function captureFareAuthorization(
  admin: SupabaseClient,
  opts: {
    authorizationId: string;
    merchantId?: string;
    amountZar?: number;
    recordOnly?: boolean;
    paystackSecret?: string;
    platformFee?: number;
  },
): Promise<{ ok: true; row: FareAuthRow } | { ok: false; message: string }> {
  let q = admin.from('fare_authorizations').select('*').eq('id', opts.authorizationId);
  if (opts.merchantId) q = q.eq('merchant_id', opts.merchantId);
  const { data: row, error } = await q.maybeSingle();

  if (error || !row) {
    return { ok: false, message: 'Authorization not found' };
  }

  const auth = row as FareAuthRow;
  if (auth.status === 'captured') {
    return { ok: true, row: auth };
  }
  if (!['authorized', 'capture_initiated'].includes(auth.status)) {
    return { ok: false, message: `Authorization is ${auth.status}` };
  }

  const captureAmount = opts.amountZar ?? Number(auth.amount_zar);
  const now = new Date().toISOString();

  if (opts.recordOnly || auth.payment_method === 'cash' || !auth.paystack_preauth_reference) {
    const { data: updated, error: upErr } = await admin
      .from('fare_authorizations')
      .update({
        status: 'captured',
        captured_amount_zar: captureAmount,
        captured_at: now,
        updated_at: now,
      })
      .eq('id', auth.id)
      .select()
      .single();
    if (upErr || !updated) {
      return { ok: false, message: upErr?.message ?? 'Capture failed' };
    }
    return { ok: true, row: updated as FareAuthRow };
  }

  if (!opts.paystackSecret) {
    return { ok: false, message: 'Paystack is not configured for capture.' };
  }

  const captureRef = auth.capture_reference ?? `takasit-cap-${auth.id}`;
  await admin.from('fare_authorizations').update({
    status: 'capture_initiated',
    captured_amount_zar: captureAmount,
    capture_reference: captureRef,
    updated_at: now,
  }).eq('id', auth.id);

  const ps = await capturePaystackPreauthorization(opts.paystackSecret, {
    reference: auth.paystack_preauth_reference,
    amountMajor: captureAmount,
    currency: auth.currency,
  });

  if (!ps.ok) {
    await admin.from('fare_authorizations').update({
      status: 'authorized',
      updated_at: new Date().toISOString(),
    }).eq('id', auth.id);
    return { ok: false, message: ps.message ?? 'Paystack capture failed' };
  }

  const psData = (ps.data ?? {}) as Record<string, unknown>;
  const txnReference = String(psData.reference ?? captureRef);
  const platformFee = opts.platformFee ?? 0;

  const { data: txn, error: txErr } = await admin.from('transactions').insert({
    merchant_id: auth.merchant_id,
    reference: txnReference,
    amount: captureAmount,
    card_amount: captureAmount,
    platform_fee: platformFee,
    currency: auth.currency,
    status: String(psData.status ?? 'success') === 'success' ? 'success' : 'pending',
    buyer_email: auth.buyer_email,
    buyer_authorised: true,
    buyer_authorised_at: now,
  }).select('id').single();

  if (txErr) {
    return { ok: false, message: txErr.message || 'Could not record capture transaction' };
  }

  const { data: updated, error: upErr } = await admin
    .from('fare_authorizations')
    .update({
      status: 'captured',
      captured_at: now,
      capture_reference: captureRef,
      paystack_reference: txnReference,
      transaction_id: txn?.id ?? null,
      updated_at: now,
    })
    .eq('id', auth.id)
    .select()
    .single();

  if (upErr || !updated) {
    return { ok: false, message: upErr?.message ?? 'Capture state update failed' };
  }

  return { ok: true, row: updated as FareAuthRow };
}

export async function releaseFareAuthorization(
  admin: SupabaseClient,
  opts: {
    authorizationId: string;
    merchantId?: string;
    paystackSecret?: string;
    recordOnly?: boolean;
  },
): Promise<{ ok: true; row: FareAuthRow } | { ok: false; message: string }> {
  let q = admin.from('fare_authorizations').select('*').eq('id', opts.authorizationId);
  if (opts.merchantId) q = q.eq('merchant_id', opts.merchantId);
  const { data: row } = await q.maybeSingle();
  if (!row) return { ok: false, message: 'Authorization not found' };

  const auth = row as FareAuthRow;
  if (auth.status === 'voided') return { ok: true, row: auth };
  if (auth.status === 'captured') {
    return { ok: false, message: 'Authorization already captured' };
  }

  if (auth.paystack_preauth_reference && opts.paystackSecret && !opts.recordOnly) {
    const ps = await releasePaystackPreauthorization(opts.paystackSecret, auth.paystack_preauth_reference);
    if (!ps.ok) {
      return { ok: false, message: ps.message ?? 'Paystack release failed' };
    }
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await admin
    .from('fare_authorizations')
    .update({ status: 'voided', updated_at: now })
    .eq('id', auth.id)
    .select()
    .single();

  if (error || !updated) {
    return { ok: false, message: error?.message ?? 'Void failed' };
  }
  return { ok: true, row: updated as FareAuthRow };
}

export async function markFareAuthorizationCaptured(
  admin: SupabaseClient,
  captureReference: string,
  transactionId?: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await admin
    .from('fare_authorizations')
    .update({
      status: 'captured',
      captured_at: now,
      updated_at: now,
      transaction_id: transactionId ?? null,
    })
    .eq('capture_reference', captureReference)
    .in('status', ['capture_initiated', 'authorized'])
    .select('id')
    .maybeSingle();
  return !!data;
}

export async function markFareAuthorizationCapturedById(
  admin: SupabaseClient,
  authorizationId: string,
  transactionId?: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await admin
    .from('fare_authorizations')
    .update({
      status: 'captured',
      captured_at: now,
      updated_at: now,
      transaction_id: transactionId ?? null,
    })
    .eq('id', authorizationId)
    .in('status', ['capture_initiated', 'authorized', 'pending_preauth'])
    .select('id')
    .maybeSingle();
  return !!data;
}

export async function resolveFareAuthByPreauthReference(
  admin: SupabaseClient,
  reference: string,
): Promise<FareAuthRow | null> {
  const { data } = await admin
    .from('fare_authorizations')
    .select('*')
    .eq('paystack_preauth_reference', reference)
    .maybeSingle();
  return (data as FareAuthRow) ?? null;
}
