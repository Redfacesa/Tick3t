// Domain checkout pricing (USD → ZAR with markup).

const DOMAIN_USD_ZAR = Number(Deno.env.get('DOMAIN_USD_ZAR_RATE') ?? '18.5');
const DOMAIN_MARKUP_PERCENT = Number(Deno.env.get('DOMAIN_MARKUP_PERCENT') ?? '15');

export function domainCheckoutZar(usdPrice: number): number {
  return Math.ceil(usdPrice * DOMAIN_USD_ZAR * (1 + DOMAIN_MARKUP_PERCENT / 100));
}
