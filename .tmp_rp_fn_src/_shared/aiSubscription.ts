// AI subscription + monthly credit limits for merchant growth features.

export type SubscriptionPlan = 'free' | 'premium' | 'business';

export const AI_MONTHLY_LIMITS: Record<SubscriptionPlan, number> = {
  free: 10,
  premium: 500,
  business: 5000,
};

export const PREMIUM_AI_ACTIONS = new Set([
  'ask',
  'insights',
  'marketing',
  'sales_coach',
  'find_leads',
  'suggest_nfc_tags',
  'scan_receipt',
  'catalog',
]);

export function effectiveSubscriptionPlan(row: {
  subscription_plan?: string | null;
  merchant_plan?: string | null;
  subscription_status?: string | null;
}): SubscriptionPlan {
  const plan = String(row.subscription_plan ?? '').toLowerCase();
  if (plan === 'premium' || plan === 'business') return plan;
  if (row.merchant_plan === 'premium' && row.subscription_status === 'active') return 'premium';
  return 'free';
}

export function monthlyAiLimit(plan: SubscriptionPlan): number {
  return AI_MONTHLY_LIMITS[plan];
}

export type AiCreditResult =
  | { ok: true; plan: SubscriptionPlan; credits_remaining: number; credits_limit: number }
  | { ok: false; code: 'PREMIUM_REQUIRED' | 'CREDITS_EXHAUSTED'; message: string; credits_remaining: number; credits_limit: number; plan: SubscriptionPlan };

export function checkAiCredits(row: {
  subscription_plan?: string | null;
  merchant_plan?: string | null;
  subscription_status?: string | null;
  ai_credits?: number | null;
  ai_credits_used?: number | null;
}, action: string): AiCreditResult {
  if (!PREMIUM_AI_ACTIONS.has(action)) {
    return { ok: true, plan: 'free', credits_remaining: 999, credits_limit: 999 };
  }

  const plan = effectiveSubscriptionPlan(row);
  const limit = Number(row.ai_credits ?? monthlyAiLimit(plan)) || monthlyAiLimit(plan);
  const used = Number(row.ai_credits_used ?? 0);
  const remaining = Math.max(0, limit - used);

  if (remaining <= 0) {
    if (plan === 'free') {
      return {
        ok: false,
        code: 'PREMIUM_REQUIRED',
        message: 'You have used your 10 free AI requests this month. Upgrade to Premium for 500 AI requests and the full growth suite.',
        credits_remaining: 0,
        credits_limit: limit,
        plan,
      };
    }
    return {
      ok: false,
      code: 'CREDITS_EXHAUSTED',
      message: `You have used all ${limit} AI credits this month. Credits reset at the start of next month.`,
      credits_remaining: 0,
      credits_limit: limit,
      plan,
    };
  }

  return { ok: true, plan, credits_remaining: remaining, credits_limit: limit };
}

export function premiumActivationPatch(now = new Date()) {
  const end = new Date(now);
  end.setMonth(end.getMonth() + 1);
  return {
    merchant_plan: 'premium',
    subscription_plan: 'premium',
    subscription_status: 'active',
    subscription_start: now.toISOString(),
    subscription_end: end.toISOString(),
    ai_credits: AI_MONTHLY_LIMITS.premium,
    ai_credits_used: 0,
    ai_credits_reset_at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
  };
}

export function freePlanPatch(now = new Date()) {
  return {
    merchant_plan: 'small',
    subscription_plan: 'free',
    subscription_status: 'cancelled',
    ai_credits: AI_MONTHLY_LIMITS.free,
    ai_credits_used: 0,
    ai_credits_reset_at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
  };
}
