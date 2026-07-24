import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

/** Mark pending buyer checkout intents completed after a verified payment. */
export async function completeBuyerPaymentIntents(
  admin: SupabaseClient,
  opts: {
    buyerEmail?: string | null;
    merchantId?: string | null;
    sessionToken?: string | null;
    clientIntentId?: string | null;
    reference?: string | null;
  },
): Promise<void> {
  const hasRef = !!opts.reference?.trim();
  const email = opts.buyerEmail?.trim().toLowerCase();
  if (!hasRef && (!email || !email.includes('@'))) return;

  const { error } = await admin.rpc('buyer_payment_intent_complete', {
    p_buyer_email: email || null,
    p_merchant_id: opts.merchantId ?? null,
    p_intent_id: null,
    p_payment_session_token: opts.sessionToken ?? null,
    p_client_intent_id: opts.clientIntentId ?? null,
    p_reference: opts.reference ?? null,
  });
  if (error) {
    console.warn('[buyerPaymentIntents] complete failed', error.message);
  }
}
