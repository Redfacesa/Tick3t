/** RedFace Studio subscription checkout — keep in sync with redface_studio/server/plan-limits.mjs */

export type StudioPlanId = 'starter' | 'pro';
export type StudioInterval = 'monthly' | 'yearly';

const PLAN_PRICES_ZAR: Record<StudioPlanId, { monthly: number; yearly: number }> = {
  starter: { monthly: 699, yearly: 579 * 12 },
  pro: { monthly: 1099, yearly: 919 * 12 },
};

export function studioAmountMajor(planId: string, interval: string): number | null {
  const id = planId as StudioPlanId;
  const row = PLAN_PRICES_ZAR[id];
  if (!row) return null;
  return interval === 'yearly' ? row.yearly : row.monthly;
}

export function studioPaystackPlanCode(planId: string, interval: string): string | null {
  const key = `PAYSTACK_PLAN_${planId.toUpperCase()}_${interval === 'yearly' ? 'YEARLY' : 'MONTHLY'}`;
  const code = Deno.env.get(key)?.trim();
  return code || null;
}

export function normalizeStudioPlanId(raw: string): StudioPlanId | null {
  const id = String(raw || '').toLowerCase();
  if (id === 'starter' || id === 'pro') return id;
  return null;
}
