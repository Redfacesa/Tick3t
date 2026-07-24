/** Payment Rail abstraction — Paystack today, SoftPOS / Stripe when live. */

/**
 * FAL name: PaymentRail. PaymentProvider is the legacy alias kept for
 * existing imports until call sites migrate.
 */
export type PaymentRailName = 'paystack' | 'stripe' | 'manual';

/** @deprecated Prefer PaymentRailName */
export type PaymentProviderName = PaymentRailName;

export type InitializeCheckoutInput = {
  email: string;
  amountSubunits: number;
  currency: string;
  reference: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
  subaccount?: string | null;
  channels?: string[];
};

export type InitializeCheckoutResult = {
  ok: boolean;
  provider: PaymentRailName;
  /** FAL alias — same as provider. */
  rail?: PaymentRailName;
  reference?: string;
  access_code?: string;
  authorization_url?: string;
  message?: string;
};

export type VerifyTransactionResult = {
  ok: boolean;
  provider: PaymentRailName;
  rail?: PaymentRailName;
  /** Provider payment status string (e.g. success, failed, pending). */
  status?: string;
  amountSubunits?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
  message?: string;
};

/**
 * Payment Rail connector. SoftPOS partners implement the same contract
 * (initialize / verify / optional refund) without business modules knowing.
 */
export interface PaymentRail {
  readonly name: PaymentRailName;
  readonly id?: PaymentRailName;
  initializeCheckout(input: InitializeCheckoutInput): Promise<InitializeCheckoutResult>;
  verifyTransaction(reference: string): Promise<VerifyTransactionResult>;
}

/** @deprecated Prefer PaymentRail */
export type PaymentProvider = PaymentRail;

/** Read active rail from env. Defaults to paystack. */
export function activeProviderName(): PaymentRailName {
  const raw = (Deno.env.get('PAYMENT_PROVIDER') ?? 'paystack').toLowerCase();
  if (raw === 'stripe') return 'stripe';
  if (raw === 'manual') return 'manual';
  return 'paystack';
}

export const activeRailName = activeProviderName;

export function isTestMode(secretKey: string): boolean {
  return secretKey.startsWith('sk_test_');
}
