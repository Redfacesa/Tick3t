/** Reconcile POS split sales when the card portion clears via Paystack. */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export async function completePosSplitCardTender(
  admin: SupabaseClient,
  saleId: string,
  reference: string,
  transactionId?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const id = String(saleId ?? '').trim();
  if (!id) return { ok: false, error: 'sale_id_required' };

  const { data, error } = await admin.rpc('complete_pos_split_card_tender', {
    p_sale_id: id,
    p_reference: reference,
    p_transaction_id: transactionId ?? null,
  });

  if (error) return { ok: false, error: error.message };
  const row = (data ?? {}) as { ok?: boolean; error?: string };
  if (!row.ok) return { ok: false, error: row.error ?? 'complete_failed' };
  return { ok: true };
}

export function posSaleIdFromMetadata(metadata: Record<string, unknown>): string | null {
  const id = String(metadata.pos_sale_id ?? '').trim();
  return id.length >= 32 ? id : null;
}
