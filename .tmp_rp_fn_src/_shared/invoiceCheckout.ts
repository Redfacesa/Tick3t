/** Invoice deposit / balance checkout amounts. */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type InvoicePaymentKind = 'deposit' | 'balance' | 'full';

export type ResolvedInvoiceCheckout = {
  ok: boolean;
  error?: string;
  invoice_id?: string;
  merchant_id?: string;
  payment_kind?: InvoicePaymentKind;
  amount?: number;
  currency?: string;
  total?: number;
  amount_paid?: number;
  balance_due?: number;
  deposit_percent?: number | null;
  deposit_amount?: number | null;
  invoice_number?: string;
  label?: string;
};

export async function resolveInvoiceCheckout(
  admin: SupabaseClient,
  invoiceId: string,
  paymentKind: InvoicePaymentKind = 'full',
): Promise<ResolvedInvoiceCheckout> {
  const { data, error } = await admin.rpc('resolve_invoice_checkout', {
    p_invoice_id: invoiceId,
    p_payment_kind: paymentKind,
  });
  if (error) return { ok: false, error: error.message };
  return (data ?? { ok: false, error: 'unknown' }) as ResolvedInvoiceCheckout;
}

export async function applyInvoicePayment(
  admin: SupabaseClient,
  invoiceId: string,
  paidAmount: number,
  reference: string,
  paymentKind: InvoicePaymentKind,
): Promise<void> {
  const { data: inv } = await admin
    .from('merchant_invoices')
    .select('id, total, amount_paid, deposit_percent, status')
    .eq('id', invoiceId)
    .maybeSingle();
  if (!inv) return;

  const newPaid = Number(inv.amount_paid ?? 0) + paidAmount;
  const total = Number(inv.total ?? 0);
  const fullyPaid = newPaid >= total - 0.009;

  const patch: Record<string, unknown> = {
    amount_paid: newPaid,
    paystack_reference: reference,
    updated_at: new Date().toISOString(),
  };

  if (paymentKind === 'deposit' && !inv.deposit_paid_at) {
    patch.deposit_paid_at = new Date().toISOString();
  }

  if (fullyPaid) {
    patch.status = 'paid';
    patch.paid_at = new Date().toISOString();
  } else if (newPaid > 0) {
    patch.status = 'partial';
  }

  await admin.from('merchant_invoices').update(patch).eq('id', invoiceId);
}
