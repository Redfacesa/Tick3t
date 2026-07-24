import { activeProviderName } from './types.ts';
import type { PaymentProvider, PaymentRail } from './types.ts';
import { createPaystackProvider, initializePaystackCheckoutFull } from './paystack.ts';
import { createStripeProvider } from './stripe.ts';

export * from './types.ts';
export { verifyResultToLegacyEnvelope } from './verifyEnvelope.ts';
export { initializePaystackCheckoutFull };

let cached: PaymentRail | null = null;

/** Singleton rail for edge functions. Set PAYMENT_PROVIDER=paystack|stripe. */
export function getPaymentProvider(): PaymentRail {
  if (cached) return cached;
  const name = activeProviderName();
  const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';
  const stripeSecret = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

  if (name === 'stripe') {
    cached = createStripeProvider(stripeSecret);
  } else {
    cached = createPaystackProvider(paystackSecret);
  }
  return cached;
}

/** FAL alias — same singleton. */
export const getPaymentRail = getPaymentProvider;

/** Reset cached provider (tests). */
export function resetPaymentProviderCache(): void {
  cached = null;
}
