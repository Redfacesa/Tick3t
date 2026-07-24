/**
 * Capability Registry + Routing & Policy Engine (v2).
 *
 * Business modules never choose providers (Platform Invariant V). They state
 * a Business Intent and a capture method; the router selects the processing
 * rail. SoftPOS is a capability; Stripe Terminal / SA SoftPOS partners implement
 * it. Paystack remains the default SA online rail.
 *
 * Vocabulary: docs/codex/platform/financial-abstraction-layer.md
 * SoftPOS: `_shared/softpos/` · ADR-017
 */

import { isStripeTerminalTtpCountry, resolveSoftposOffer } from './softpos/countryGate.ts';

export type CaptureMethod =
  | 'qr'
  | 'nfc_tap'
  | 'payment_link'
  | 'manual_card'
  | 'checkout'
  | 'table_pay'
  | 'cash'
  | 'store_credit'
  | 'apple_tap'
  | 'softpos'
  | 'google_tap'
  | 'external_terminal';

/**
 * Processing rails — who moves the money.
 * SoftPOS: stripe_terminal (where Terminal TTP is supported) or SA partners
 * (istore_tap / yoco_tap). Online SA defaults to paystack.
 */
export type ProcessingRail =
  | 'paystack'
  | 'stripe'
  | 'stripe_terminal'
  | 'cash'
  | 'store_credit'
  | 'wallet'
  | 'istore_tap'
  | 'yoco_tap';

export type CapabilityDescriptor = {
  id: string;
  kind: 'capture' | 'rail';
  label: string;
  countries: string[] | 'all';
  currencies: string[] | 'all';
  /** Requirements a merchant must satisfy before the capability is offered. */
  requirements: string[];
  status: 'active' | 'planned';
  /** Optional: which capture methods this rail can settle. */
  supportsCapture?: CaptureMethod[];
};

/**
 * v2 registry remains code-backed. It becomes DB-backed (per-merchant health,
 * entitlements, partner onboarding) when a second live rail ships.
 */
export const CAPABILITY_REGISTRY: CapabilityDescriptor[] = [
  { id: 'qr_capture', kind: 'capture', label: 'QR capture', countries: 'all', currencies: 'all', requirements: [], status: 'active' },
  { id: 'nfc_tap_capture', kind: 'capture', label: 'NFC tap capture', countries: 'all', currencies: 'all', requirements: ['payment_object'], status: 'active' },
  { id: 'payment_link_capture', kind: 'capture', label: 'Payment link capture', countries: 'all', currencies: 'all', requirements: [], status: 'active' },
  { id: 'manual_card_capture', kind: 'capture', label: 'Manual card entry', countries: 'all', currencies: 'all', requirements: [], status: 'active' },
  { id: 'cash_capture', kind: 'capture', label: 'Cash capture', countries: 'all', currencies: 'all', requirements: [], status: 'active' },
  { id: 'store_credit_capture', kind: 'capture', label: 'Store credit redemption', countries: 'all', currencies: 'all', requirements: ['store_credit_program'], status: 'active' },
  {
    id: 'apple_tap_capture',
    kind: 'capture',
    label: 'Apple Tap to Pay',
    countries: 'all',
    currencies: 'all',
    requirements: ['ios_device', 'softpos_entitlement'],
    status: 'planned',
  },
  {
    id: 'softpos_capture',
    kind: 'capture',
    label: 'SoftPOS (phone as terminal)',
    countries: 'all',
    currencies: 'all',
    requirements: ['softpos_entitlement'],
    status: 'planned',
  },
  {
    id: 'google_tap_capture',
    kind: 'capture',
    label: 'Google Tap to Pay',
    countries: 'all',
    currencies: 'all',
    requirements: ['android_device', 'softpos_entitlement'],
    status: 'planned',
  },
  {
    id: 'paystack_rail',
    kind: 'rail',
    label: 'Paystack',
    countries: ['ZA', 'NG', 'GH', 'KE'],
    currencies: ['ZAR', 'NGN', 'GHS', 'KES', 'USD'],
    requirements: ['paystack_subaccount'],
    status: 'active',
    supportsCapture: ['qr', 'nfc_tap', 'payment_link', 'manual_card', 'checkout', 'table_pay'],
  },
  {
    id: 'stripe_rail',
    kind: 'rail',
    label: 'Stripe Checkout',
    countries: 'all',
    currencies: ['USD', 'EUR', 'GBP', 'CHF', 'ZAR'],
    requirements: ['stripe_account'],
    status: 'planned',
    supportsCapture: ['checkout', 'payment_link'],
  },
  {
    id: 'stripe_terminal_rail',
    kind: 'rail',
    label: 'Stripe Terminal SoftPOS',
    countries: 'all',
    currencies: 'all',
    requirements: ['stripe_account', 'softpos_entitlement', 'terminal_ttp_country'],
    status: 'planned',
    supportsCapture: ['softpos', 'apple_tap', 'google_tap'],
  },
  { id: 'cash_rail', kind: 'rail', label: 'Cash (internal settlement)', countries: 'all', currencies: 'all', requirements: [], status: 'active', supportsCapture: ['cash'] },
  { id: 'store_credit_rail', kind: 'rail', label: 'Store credit (internal)', countries: 'all', currencies: 'all', requirements: ['store_credit_program'], status: 'active', supportsCapture: ['store_credit'] },
  {
    id: 'istore_tap_rail',
    kind: 'rail',
    label: 'iStore Tap (SoftPOS)',
    countries: ['ZA'],
    currencies: ['ZAR'],
    requirements: ['tap_partner_onboarding'],
    status: 'planned',
    supportsCapture: ['apple_tap', 'softpos'],
  },
  {
    id: 'yoco_tap_rail',
    kind: 'rail',
    label: 'Yoco SoftPOS',
    countries: ['ZA'],
    currencies: ['ZAR'],
    requirements: ['tap_partner_onboarding'],
    status: 'planned',
    supportsCapture: ['softpos', 'external_terminal'],
  },
  { id: 'bank_transfer_capture', kind: 'capture', label: 'Bank transfer', countries: 'all', currencies: 'all', requirements: ['dedicated_account'], status: 'active' },
  { id: 'crypto_capture', kind: 'capture', label: 'Crypto payment', countries: 'all', currencies: 'all', requirements: ['crypto_wallets'], status: 'active' },
];

export type SoftposPartner = 'istore_tap' | 'yoco_tap' | 'stripe_terminal' | null;

export type RoutingContext = {
  merchantId: string;
  currency?: string | null;
  country?: string | null;
  captureMethod?: CaptureMethod | string | null;
  businessIntent?: string | null;
  /** When SoftPOS partner onboarding is complete, set the live partner id. */
  softposPartner?: SoftposPartner;
  /** Merchant entitled to Stripe Terminal SoftPOS (after Stripe confirms). */
  stripeTerminalEntitled?: boolean;
  /** Ops override — support tooling only. */
  forceRail?: ProcessingRail | null;
};

export type RoutingDecision = {
  rail: ProcessingRail;
  reason: string;
  /** True when a planned SoftPOS rail was preferred but is not live yet. */
  fallback?: boolean;
  plannedRail?: ProcessingRail | null;
  captureMethod: string;
  decidedAt: string;
};

const PAYSTACK_COUNTRIES = new Set(['ZA', 'NG', 'GH', 'KE']);

function normalizeCountry(country?: string | null): string {
  return String(country ?? 'ZA').trim().toUpperCase() || 'ZA';
}

function normalizeCurrency(currency?: string | null, country?: string): string {
  const c = String(currency ?? '').trim().toUpperCase();
  if (c) return c;
  if (country === 'NG') return 'NGN';
  if (country === 'GH') return 'GHS';
  if (country === 'KE') return 'KES';
  return 'ZAR';
}

function isSoftposCapture(capture: string): boolean {
  return capture === 'apple_tap' || capture === 'softpos' || capture === 'google_tap';
}

/**
 * Routing & Policy Engine v2.
 * Deterministic rules; SoftPOS partners register as planned until entitlement.
 * Provider health / cost / auth-rate signals arrive with the second live acquirer.
 */
export function selectProcessingRail(ctx: RoutingContext): RoutingDecision {
  const capture = String(ctx.captureMethod ?? '').trim().toLowerCase() || 'payment_link';
  const country = normalizeCountry(ctx.country);
  const currency = normalizeCurrency(ctx.currency, country);
  const decidedAt = new Date().toISOString();

  if (ctx.forceRail) {
    return {
      rail: ctx.forceRail,
      reason: `ops override → ${ctx.forceRail}`,
      captureMethod: capture,
      decidedAt,
    };
  }

  if (capture === 'cash') {
    return {
      rail: 'cash',
      reason: 'cash capture settles internally on the merchant ledger',
      captureMethod: capture,
      decidedAt,
    };
  }
  if (capture === 'store_credit') {
    return {
      rail: 'store_credit',
      reason: 'store credit settles against the merchant liability ledger',
      captureMethod: capture,
      decidedAt,
    };
  }

  // SoftPOS / Tap to Pay — capability; provider selected by country + entitlement.
  // Never assume Swiss Stripe platform ⇒ SoftPOS for ZA operating merchants.
  if (isSoftposCapture(capture)) {
    const saPartner =
      ctx.softposPartner === 'istore_tap' || ctx.softposPartner === 'yoco_tap'
        ? ctx.softposPartner
        : null;
    const stripeEntitled =
      Boolean(ctx.stripeTerminalEntitled) || ctx.softposPartner === 'stripe_terminal';
    const offer = resolveSoftposOffer({
      country,
      stripeTerminalEntitled: stripeEntitled,
      saPartner,
    });

    if (offer.offered && offer.providerId === 'istore_tap') {
      return {
        rail: 'istore_tap',
        reason: offer.reason,
        captureMethod: capture,
        decidedAt,
      };
    }
    if (offer.offered && offer.providerId === 'yoco_tap') {
      return {
        rail: 'yoco_tap',
        reason: offer.reason,
        captureMethod: capture,
        decidedAt,
      };
    }
    if (offer.offered && offer.providerId === 'stripe_terminal') {
      return {
        rail: 'stripe_terminal',
        reason: offer.reason,
        captureMethod: capture,
        decidedAt,
      };
    }

    const plannedRail: ProcessingRail | null =
      country === 'ZA'
        ? 'istore_tap'
        : isStripeTerminalTtpCountry(country)
          ? 'stripe_terminal'
          : null;

    // SoftPOS is not live — do not route in-person tap to Paystack SoftPOS.
    // Online SA capture still uses Paystack via link/QR/checkout actions.
    return {
      rail: PAYSTACK_COUNTRIES.has(country) ? 'paystack' : 'stripe',
      reason: offer.reason,
      fallback: true,
      plannedRail,
      captureMethod: capture,
      decidedAt,
    };
  }

  // Country-aware default acquiring (online / QR / links / checkout)
  if (PAYSTACK_COUNTRIES.has(country)) {
    return {
      rail: 'paystack',
      reason: `default SA/Africa online acquiring rail for ${country}/${currency}`,
      captureMethod: capture,
      decidedAt,
    };
  }

  // Non-Paystack countries: Stripe Checkout when configured, else Paystack fallback label.
  return {
    rail: 'stripe',
    reason: `international online rail for ${country}/${currency} (Stripe Checkout when active)`,
    captureMethod: capture,
    decidedAt,
  };
}

export function listActiveCapabilities(kind?: 'capture' | 'rail'): CapabilityDescriptor[] {
  return CAPABILITY_REGISTRY.filter(
    (c) => c.status === 'active' && (kind ? c.kind === kind : true),
  );
}

export function listPlannedCapabilities(kind?: 'capture' | 'rail'): CapabilityDescriptor[] {
  return CAPABILITY_REGISTRY.filter(
    (c) => c.status === 'planned' && (kind ? c.kind === kind : true),
  );
}

/** Serialize a routing decision for payment_sessions.metadata.routing */
export function routingDecisionToMeta(decision: RoutingDecision): Record<string, unknown> {
  return {
    rail: decision.rail,
    reason: decision.reason,
    capture_method: decision.captureMethod,
    decided_at: decision.decidedAt,
    ...(decision.fallback ? { fallback: true } : {}),
    ...(decision.plannedRail ? { planned_rail: decision.plannedRail } : {}),
  };
}
