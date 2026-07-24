import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type DvaCountry = { code: 'NG' | 'GH'; currency: string };

export function dvaEligibleCountry(country: string | null | undefined): DvaCountry | null {
  const c = String(country ?? '').trim().toLowerCase();
  if (c === 'nigeria' || c === 'ng') return { code: 'NG', currency: 'NGN' };
  if (c === 'ghana' || c === 'gh') return { code: 'GH', currency: 'GHS' };
  return null;
}

export function splitMerchantContactName(businessName: string): { firstName: string; lastName: string } {
  const parts = String(businessName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Merchant', lastName: 'Account' };
  if (parts.length === 1) return { firstName: parts[0], lastName: 'Business' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export type PaystackDvaPayload = Record<string, unknown>;

export async function upsertMerchantDedicatedAccount(
  admin: SupabaseClient,
  merchantId: string,
  dvaData: PaystackDvaPayload,
  patch: { status?: string; error_message?: string | null } = {},
): Promise<void> {
  const bank = (dvaData.bank ?? {}) as Record<string, unknown>;
  const customer = (dvaData.customer ?? {}) as Record<string, unknown>;
  const countryCode = String(dvaData.currency ?? 'NGN').toUpperCase() === 'GHS' ? 'GH' : 'NG';
  const active = dvaData.active === true || dvaData.active === 1 || dvaData.assigned === true;

  await admin.from('merchant_dedicated_accounts').upsert({
    merchant_id: merchantId,
    status: patch.status ?? (active ? 'active' : 'pending'),
    country_code: countryCode,
    currency: String(dvaData.currency ?? (countryCode === 'GH' ? 'GHS' : 'NGN')).toUpperCase(),
    paystack_customer_code: customer.customer_code ? String(customer.customer_code) : null,
    paystack_dva_id: dvaData.id != null ? String(dvaData.id) : null,
    account_number: dvaData.account_number ? String(dvaData.account_number) : null,
    account_name: dvaData.account_name ? String(dvaData.account_name) : null,
    bank_name: bank.name ? String(bank.name) : null,
    bank_slug: bank.slug ? String(bank.slug) : null,
    is_active: active,
    error_message: patch.error_message ?? null,
    meta: dvaData,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'merchant_id' });
}

export async function resolveMerchantFromDedicatedAccountNumber(
  admin: SupabaseClient,
  accountNumber: string,
): Promise<string | null> {
  const num = String(accountNumber ?? '').trim();
  if (!num) return null;
  const { data } = await admin
    .from('merchant_dedicated_accounts')
    .select('merchant_id')
    .eq('account_number', num)
    .eq('is_active', true)
    .maybeSingle();
  return (data?.merchant_id as string) ?? null;
}

export async function resolveMerchantIdForDvaWebhook(
  admin: SupabaseClient,
  data: Record<string, unknown>,
): Promise<string | null> {
  const dva = (data.dedicated_account ?? data) as PaystackDvaPayload;
  const accountNumber = String(dva.account_number ?? '').trim();
  if (accountNumber) {
    const byNumber = await resolveMerchantFromDedicatedAccountNumber(admin, accountNumber);
    if (byNumber) return byNumber;
  }

  const customer = (data.customer ?? dva.customer ?? {}) as Record<string, unknown>;
  const email = String(customer.email ?? '').trim().toLowerCase();
  if (email) {
    const { data: merchant } = await admin
      .from('merchants')
      .select('id')
      .ilike('email', email)
      .eq('status', 'approved')
      .maybeSingle();
    if (merchant?.id) return String(merchant.id);
  }

  const customerCode = String(customer.customer_code ?? '').trim();
  if (customerCode) {
    const { data: row } = await admin
      .from('merchant_dedicated_accounts')
      .select('merchant_id')
      .eq('paystack_customer_code', customerCode)
      .maybeSingle();
    if (row?.merchant_id) return String(row.merchant_id);
  }

  return null;
}
