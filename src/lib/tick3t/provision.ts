import { supabase } from '@/lib/supabase';

export type ProvisionSubaccountResult = {
  ok: boolean;
  subaccount?: string | null;
  message?: string;
  alreadyApproved?: boolean;
};

/** Create / reuse Paystack subaccount for a Tick3t merchant (owner or admin JWT). */
export async function provisionTick3tMerchantSubaccount(
  merchantId: string,
): Promise<ProvisionSubaccountResult> {
  const { data, error } = await supabase.functions.invoke('redface-pay', {
    body: { action: 'tick3t_provision_subaccount', merchant_id: merchantId },
  });
  if (error || !data?.status) {
    let msg = data?.message || error?.message || 'Subaccount creation failed';
    try {
      const body = await (
        error as { context?: { json?: () => Promise<{ message?: string }> } }
      )?.context?.json?.();
      if (body?.message) msg = body.message;
    } catch {
      /* ignore */
    }
    return { ok: false, message: msg };
  }
  return {
    ok: true,
    subaccount: (data.subaccount as string | null | undefined) ?? null,
    alreadyApproved: Boolean(data.already_approved),
  };
}

export type Tick3tCommerceStatus = {
  ok: boolean;
  merchant_id?: string;
  is_platform_merchant?: boolean;
  bank_complete?: boolean;
  has_subaccount?: boolean;
  paystack_subaccount?: string | null;
  can_receive_payouts?: boolean;
  needs_subaccount?: boolean;
  message?: string;
};

export async function fetchTick3tMerchantCommerceStatus(
  merchantId: string,
): Promise<Tick3tCommerceStatus | null> {
  const { data, error } = await supabase.rpc('tick3t_merchant_commerce_status', {
    p_merchant_id: merchantId,
  });
  if (error || !data?.ok) return null;
  return data as Tick3tCommerceStatus;
}
