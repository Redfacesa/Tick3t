/** Platform fee plan resolution — premium subscribers pay 0% while active. */

export type MerchantPlan = 'small' | 'marketplace' | 'premium' | 'founding';

export function defaultPlanPercent(plan: MerchantPlan): number {
  switch (plan) {
    case 'founding':
      return 1.5;
    case 'marketplace':
      return 5;
    case 'premium':
      return 0;
    default:
      return 2;
  }
}

export function feePlanFromMerchant(merchant: {
  merchant_plan?: string | null;
  subscription_status?: string | null;
}): MerchantPlan {
  const raw = String(merchant.merchant_plan ?? 'small');
  if (raw === 'founding') return 'founding';
  if (raw === 'marketplace') return 'marketplace';
  if (raw === 'premium' && merchant.subscription_status === 'active') return 'premium';
  return 'small';
}
