/** Store credit redemption at checkout — ledger-only, Paystack for card remainder. */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type StoreCreditRow = {
  id: string;
  balance_remaining: number;
  currency: string;
  code: string;
};

export async function resolveStoreCreditForCheckout(
  admin: SupabaseClient,
  creditId: string,
  merchantId: string,
  buyerEmail: string,
): Promise<{ ok: true; credit: StoreCreditRow } | { ok: false; message: string }> {
  const email = buyerEmail.trim().toLowerCase();
  if (!creditId || !email.includes('@')) {
    return { ok: false, message: 'Store credit not available' };
  }

  await admin.rpc('_expire_store_credits').then(() => {}, () => {});

  const { data: row, error } = await admin
    .from('merchant_store_credits')
    .select('id, balance_remaining, currency, code, buyer_email, status, expires_at')
    .eq('id', creditId)
    .eq('merchant_id', merchantId)
    .maybeSingle();

  if (error || !row) {
    return { ok: false, message: 'Store credit not found' };
  }
  if (String(row.buyer_email).toLowerCase() !== email) {
    return { ok: false, message: 'Store credit does not match this email' };
  }
  if (row.status !== 'active' || Number(row.balance_remaining) <= 0) {
    return { ok: false, message: 'Store credit is no longer available' };
  }
  if (row.expires_at && new Date(String(row.expires_at)) < new Date()) {
    return { ok: false, message: 'Store credit has expired' };
  }

  return {
    ok: true,
    credit: {
      id: String(row.id),
      balance_remaining: Number(row.balance_remaining),
      currency: String(row.currency || 'ZAR'),
      code: String(row.code),
    },
  };
}

export function splitStoreCreditAmount(orderAmount: number, creditBalance: number): {
  storeCreditApplied: number;
  cardAmount: number;
} {
  const applied = Math.min(Math.max(creditBalance, 0), Math.max(orderAmount, 0));
  const card = Math.round((orderAmount - applied) * 100) / 100;
  return { storeCreditApplied: applied, cardAmount: card > 0 ? card : 0 };
}

export async function redeemStoreCreditIfNeeded(
  admin: SupabaseClient,
  opts: {
    creditId: string | null;
    merchantId: string;
    buyerEmail: string;
    amount: number;
    reference: string;
    transactionId?: string | null;
  },
): Promise<{ ok: boolean; message?: string }> {
  const { creditId, merchantId, buyerEmail, amount, reference, transactionId } = opts;
  if (!creditId || amount <= 0) return { ok: true };

  const { data, error } = await admin.rpc('store_credit_redeem', {
    p_credit_id: creditId,
    p_merchant_id: merchantId,
    p_buyer_email: buyerEmail,
    p_amount: amount,
    p_reference: reference,
    p_transaction_id: transactionId ?? null,
  });

  if (error) {
    console.error('store_credit_redeem failed', error);
    return { ok: false, message: error.message || 'Could not apply store credit' };
  }
  if (!data?.ok) {
    return { ok: false, message: String(data?.error || 'Could not apply store credit') };
  }
  return { ok: true };
}
