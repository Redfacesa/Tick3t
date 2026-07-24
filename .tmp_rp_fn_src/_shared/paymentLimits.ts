/** Minimum card checkout amounts — keep in sync with src/lib/paymentLimits.ts */

export const MIN_CARD_PAYMENT_ZAR_MAJOR = 5;
export const MIN_CARD_PAYMENT_ZAR_SUBUNITS = MIN_CARD_PAYMENT_ZAR_MAJOR * 100;

export function minCardAmountMessage(currency: string): string {
  if (currency.toUpperCase() === 'ZAR') {
    return `Minimum card payment is R${MIN_CARD_PAYMENT_ZAR_MAJOR}. Amounts under R${MIN_CARD_PAYMENT_ZAR_MAJOR} often fail after payment partner fees. Try R${MIN_CARD_PAYMENT_ZAR_MAJOR} or more.`;
  }
  return 'This amount is too small for card checkout after processing fees. Try a higher amount.';
}

export function minCardAmountSubunits(currency: string): number {
  return currency.toUpperCase() === 'ZAR' ? MIN_CARD_PAYMENT_ZAR_SUBUNITS : 100;
}

export function assertCardAmountViable(amountSub: number, currency: string): string | null {
  const cur = currency.toUpperCase();
  const minSub = minCardAmountSubunits(cur);
  if (amountSub < minSub) return minCardAmountMessage(currency);
  const estProcessorFee =
    cur === 'ZAR' ? Math.ceil(amountSub * 0.029) + 100 : Math.ceil(amountSub * 0.039);
  if (amountSub - estProcessorFee <= 0) return minCardAmountMessage(currency);
  return null;
}

export function minChargeSubunits(currency?: string): number {
  return minCardAmountSubunits(String(currency ?? 'ZAR'));
}

export function minChargeMessage(currency?: string): string {
  const cur = String(currency ?? 'ZAR').toUpperCase();
  if (cur === 'ZAR') {
    return `Minimum charge amount is R${MIN_CARD_PAYMENT_ZAR_MAJOR}.00`;
  }
  return 'Minimum charge amount is too low for card checkout';
}
