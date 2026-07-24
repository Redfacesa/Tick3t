import type {
  InitializeCheckoutInput,
  InitializeCheckoutResult,
  PaymentProvider,
  VerifyTransactionResult,
} from './types.ts';

const STRIPE_API = 'https://api.stripe.com/v1';

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export function createStripeProvider(secretKey: string): PaymentProvider {
  return {
    name: 'stripe',
    async initializeCheckout(input: InitializeCheckoutInput): Promise<InitializeCheckoutResult> {
      if (!secretKey?.startsWith('sk_')) {
        return { ok: false, provider: 'stripe', message: 'STRIPE_SECRET_KEY is not configured' };
      }
      try {
        const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formBody({
            mode: 'payment',
            success_url: `${input.callbackUrl}?stripe=success&reference=${encodeURIComponent(input.reference)}`,
            cancel_url: `${input.callbackUrl}?stripe=cancel&reference=${encodeURIComponent(input.reference)}`,
            customer_email: input.email,
            client_reference_id: input.reference,
            'line_items[0][price_data][currency]': input.currency.toLowerCase(),
            'line_items[0][price_data][unit_amount]': String(input.amountSubunits),
            'line_items[0][price_data][product_data][name]': String(input.metadata?.label ?? 'RedFace Pay'),
            'line_items[0][quantity]': '1',
            'metadata[merchant_id]': String(input.metadata?.merchant_id ?? ''),
            'metadata[reference]': input.reference,
          }),
        });
        const data = await res.json().catch(() => ({})) as {
          error?: { message?: string };
          url?: string;
          id?: string;
        };
        if (!res.ok) {
          return { ok: false, provider: 'stripe', message: data.error?.message || 'Stripe checkout failed' };
        }
        return {
          ok: true,
          provider: 'stripe',
          reference: input.reference,
          authorization_url: data.url,
          access_code: data.id,
        };
      } catch (err) {
        return { ok: false, provider: 'stripe', message: err instanceof Error ? err.message : 'Stripe error' };
      }
    },

    async verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
      if (!secretKey?.startsWith('sk_')) {
        return { ok: false, provider: 'stripe', message: 'STRIPE_SECRET_KEY is not configured' };
      }
      try {
        const res = await fetch(
          `${STRIPE_API}/checkout/sessions?limit=1&client_reference_id=${encodeURIComponent(reference)}`,
          { headers: { Authorization: `Bearer ${secretKey}` } },
        );
        const data = await res.json().catch(() => ({})) as {
          error?: { message?: string };
          data?: Array<{ payment_status?: string; amount_total?: number; currency?: string }>;
        };
        if (!res.ok) {
          return { ok: false, provider: 'stripe', message: data.error?.message || 'Stripe verify failed' };
        }
        const session = data.data?.[0];
        return {
          ok: true,
          provider: 'stripe',
          status: session?.payment_status,
          amountSubunits: session?.amount_total,
          currency: session?.currency?.toUpperCase(),
        };
      } catch (err) {
        return { ok: false, provider: 'stripe', message: err instanceof Error ? err.message : 'Stripe error' };
      }
    },
  };
}
