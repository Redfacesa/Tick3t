/** Developer API tier billing — amounts aligned with src/lib/pluginEcosystem.ts */

export const DEVELOPER_API_TIER_AMOUNTS_ZAR = {
  developer: 199,
  growth: 999,
} as const;

export type PaidDeveloperTier = keyof typeof DEVELOPER_API_TIER_AMOUNTS_ZAR;

export function developerTierAmountZar(tier: PaidDeveloperTier): number {
  return DEVELOPER_API_TIER_AMOUNTS_ZAR[tier];
}

export function isPaidDeveloperTier(tier: string): tier is PaidDeveloperTier {
  return tier === 'developer' || tier === 'growth';
}
