/**
 * SoftPOS country / entitlement gate.
 *
 * A Swiss Stripe platform account does NOT imply SoftPOS in South Africa.
 * Availability follows Stripe Terminal Tap to Pay country lists + merchant
 * operating country (Terminal Location), plus explicit entitlement.
 *
 * Sources (GA, not preview): Stripe Tap to Pay docs — iOS + Android.
 * Update when Stripe expands markets; do not invent ZA support.
 */

/** Countries where Stripe Tap to Pay is generally available (union iOS + Android GA). */
export const STRIPE_TERMINAL_TTP_COUNTRIES = new Set([
  'AT',
  'AU',
  'BE',
  'CA',
  'CH',
  'CZ',
  'DE',
  'DK',
  'ES',
  'FI',
  'FR',
  'GB',
  'IE',
  'IT',
  'MY',
  'NL',
  'NZ',
  'PL',
  'PT',
  'SE',
  'SG',
  'US',
]);

export function normalizeSoftposCountry(country?: string | null): string {
  return String(country ?? '').trim().toUpperCase() || 'ZA';
}

/** Stripe Terminal Tap to Pay may be offered only in these operating countries. */
export function isStripeTerminalTtpCountry(country?: string | null): boolean {
  return STRIPE_TERMINAL_TTP_COUNTRIES.has(normalizeSoftposCountry(country));
}

/**
 * SoftPOS offered to the merchant UI / routing.
 * ZA SoftPOS requires a local partner entitlement — never Stripe TTP by default.
 */
export function resolveSoftposOffer(ctx: {
  country?: string | null;
  stripeTerminalEntitled?: boolean;
  saPartner?: 'istore_tap' | 'yoco_tap' | null;
  allowSimulator?: boolean;
}): {
  offered: boolean;
  providerId: 'stripe_terminal' | 'istore_tap' | 'yoco_tap' | 'simulator' | null;
  reason: string;
} {
  const country = normalizeSoftposCountry(ctx.country);

  if (ctx.allowSimulator && Deno.env.get('SOFTPOS_SIMULATOR') === '1') {
    return { offered: true, providerId: 'simulator', reason: 'SOFTPOS_SIMULATOR=1' };
  }

  if (ctx.saPartner === 'istore_tap' && country === 'ZA') {
    return { offered: true, providerId: 'istore_tap', reason: 'ZA SoftPOS via iStore entitlement' };
  }
  if (ctx.saPartner === 'yoco_tap' && country === 'ZA') {
    return { offered: true, providerId: 'yoco_tap', reason: 'ZA SoftPOS via Yoco entitlement' };
  }

  // Stripe TTP: requires Terminal-supported operating country AND entitlement.
  // Env SOFTPOS_STRIPE_ENABLED=1 unlocks after Stripe confirms the business case.
  const stripeEnabled = Deno.env.get('SOFTPOS_STRIPE_ENABLED') === '1';
  if (
    stripeEnabled &&
    ctx.stripeTerminalEntitled &&
    isStripeTerminalTtpCountry(country)
  ) {
    return {
      offered: true,
      providerId: 'stripe_terminal',
      reason: `Stripe Terminal Tap to Pay for ${country}`,
    };
  }

  if (country === 'ZA') {
    return {
      offered: false,
      providerId: null,
      reason:
        'SoftPOS not live in ZA via Stripe Terminal; awaiting SA SoftPOS partner or Stripe confirmation',
    };
  }

  if (isStripeTerminalTtpCountry(country) && !stripeEnabled) {
    return {
      offered: false,
      providerId: null,
      reason: 'Stripe Terminal country, but SoftPOS gated until SOFTPOS_STRIPE_ENABLED=1 and entitlement',
    };
  }

  return {
    offered: false,
    providerId: null,
    reason: `SoftPOS not available for operating country ${country}`,
  };
}
