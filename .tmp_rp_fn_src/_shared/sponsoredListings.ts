/** Paystack plan codes & pricing for marketplace boosts (server-side). */

export const SPONSORED_7D_ZAR = Number(Deno.env.get('SPONSORED_LISTING_7D_ZAR') ?? '99');
export const SPONSORED_14D_ZAR = Number(Deno.env.get('SPONSORED_LISTING_14D_ZAR') ?? '179');
export const SPONSORED_30D_ZAR = Number(Deno.env.get('SPONSORED_LISTING_30D_ZAR') ?? '299');

export function normalizeSponsoredDays(raw: number): 7 | 14 | 30 {
  if (raw <= 7) return 7;
  if (raw <= 14) return 14;
  return 30;
}

export function sponsoredListingPrice(days: number): number {
  const d = normalizeSponsoredDays(days);
  if (d === 7) return SPONSORED_7D_ZAR;
  if (d === 14) return SPONSORED_14D_ZAR;
  return SPONSORED_30D_ZAR;
}

export function sponsoredPlanCode(days: number): string {
  const d = normalizeSponsoredDays(days);
  if (d === 7) return Deno.env.get('SPONSORED_PLAN_7D') ?? 'PLN_ggm8dwotpsdncfb';
  if (d === 14) return Deno.env.get('SPONSORED_PLAN_14D') ?? 'PLN_qn4oukab6jodg1x';
  return Deno.env.get('SPONSORED_PLAN_30D') ?? 'PLN_wsyk1xw3iyx60vb';
}
