import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkAiCredits, PREMIUM_AI_ACTIONS } from './aiSubscription.ts';

export async function requireUser(admin: SupabaseClient, req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user?.email) return null;
  return data.user.email.toLowerCase();
}

export async function requireMerchantById(
  admin: SupabaseClient,
  req: Request,
  merchantId: string,
) {
  const email = await requireUser(admin, req);
  if (!email) return null;

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, business_name, country, category, email, subscription_plan, merchant_plan, subscription_status, ai_credits, ai_credits_used, ai_credits_reset_at')
    .eq('id', merchantId)
    .ilike('email', email)
    .maybeSingle();
  if (merchant?.id === merchantId) return merchant;

  const { data: staffRow } = await admin
    .from('merchant_staff')
    .select('merchant_id')
    .ilike('email', email)
    .eq('status', 'active')
    .eq('merchant_id', merchantId)
    .maybeSingle();
  if (!staffRow) return null;

  const { data: staffMerchant } = await admin
    .from('merchants')
    .select('id, business_name, country, category, email, subscription_plan, merchant_plan, subscription_status, ai_credits, ai_credits_used, ai_credits_reset_at')
    .eq('id', merchantId)
    .maybeSingle();
  return staffMerchant?.id === merchantId ? staffMerchant : null;
}

async function resetCreditsIfDue(admin: SupabaseClient, merchantId: string) {
  const { error } = await admin.rpc('reset_merchant_ai_credits_if_due', { p_merchant_id: merchantId });
  if (error && error.code !== '42883') {
    console.warn('reset_merchant_ai_credits_if_due failed', error.message);
  }
}

export async function consumeAiCredit(
  admin: SupabaseClient,
  merchantId: string,
  action: string,
) {
  if (!PREMIUM_AI_ACTIONS.has(action)) {
    return { ok: true as const, credits_remaining: 999 };
  }

  await resetCreditsIfDue(admin, merchantId);
  const { data: row } = await admin
    .from('merchants')
    .select('subscription_plan, merchant_plan, subscription_status, ai_credits, ai_credits_used')
    .eq('id', merchantId)
    .maybeSingle();
  if (!row) return { ok: false as const, status: 404, body: { error: 'Merchant not found.' } };

  const gate = checkAiCredits(row, action);
  if (!gate.ok) {
    return {
      ok: false as const,
      status: gate.code === 'PREMIUM_REQUIRED' ? 402 : 429,
      body: {
        error: gate.message,
        code: gate.code,
        credits_remaining: gate.credits_remaining,
        credits_limit: gate.credits_limit,
      },
    };
  }

  await admin
    .from('merchants')
    .update({ ai_credits_used: Number(row.ai_credits_used ?? 0) + 1 })
    .eq('id', merchantId);

  return {
    ok: true as const,
    credits_remaining: Math.max(0, gate.credits_remaining - 1),
  };
}
