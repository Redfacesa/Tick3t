import type {
  InitializeCheckoutInput,
  InitializeCheckoutResult,
  PaymentProvider,
  VerifyTransactionResult,
} from './types.ts';

const PAYSTACK_BASE = 'https://api.paystack.co';

async function paystackPost(secret: string, path: string, body: unknown) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { status: false, message: (data as { message?: string }).message || res.statusText, data };
  }
  return { status: true, data: (data as { data?: Record<string, unknown> }).data, message: (data as { message?: string }).message };
}

async function paystackGet(secret: string, path: string) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { status: false, message: (data as { message?: string }).message || res.statusText, data };
  }
  return { status: true, data: (data as { data?: Record<string, unknown> }).data };
}

export function createPaystackProvider(secretKey: string): PaymentProvider {
  return {
    name: 'paystack',
    async initializeCheckout(input: InitializeCheckoutInput): Promise<InitializeCheckoutResult> {
      const payload: Record<string, unknown> = {
        email: input.email,
        amount: input.amountSubunits,
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: input.metadata ?? {},
      };
      if (input.subaccount) payload.subaccount = input.subaccount;
      if (input.channels?.length) payload.channels = input.channels;

      const ps = await paystackPost(secretKey, '/transaction/initialize', payload);
      if (!ps.status) {
        return { ok: false, provider: 'paystack', message: ps.message || 'Paystack initialize failed' };
      }
      const row = ps.data ?? {};
      return {
        ok: true,
        provider: 'paystack',
        reference: String(row.reference ?? input.reference),
        access_code: row.access_code ? String(row.access_code) : undefined,
        authorization_url: row.authorization_url ? String(row.authorization_url) : undefined,
      };
    },

    async verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
      const ps = await paystackGet(secretKey, `/transaction/verify/${encodeURIComponent(reference)}`);
      if (!ps.status) {
        return { ok: false, provider: 'paystack', message: ps.message || 'Verify failed' };
      }
      const row = (ps.data ?? {}) as Record<string, unknown>;
      const metadata =
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : undefined;
      return {
        ok: true,
        provider: 'paystack',
        status: String(row.status ?? ''),
        amountSubunits: Number(row.amount) || undefined,
        currency: row.currency ? String(row.currency) : undefined,
        metadata,
        message: typeof ps.message === 'string' ? ps.message : undefined,
      };
    },
  };
}

/** Full Paystack initialize payload (split codes, subaccount routing, etc.). */
export async function initializePaystackCheckoutFull(
  secretKey: string,
  payload: Record<string, unknown>,
): Promise<InitializeCheckoutResult> {
  const ps = await paystackPost(secretKey, '/transaction/initialize', payload);
  if (!ps.status) {
    return { ok: false, provider: 'paystack', message: ps.message || 'Paystack initialize failed' };
  }
  const row = ps.data ?? {};
  return {
    ok: true,
    provider: 'paystack',
    reference: String(row.reference ?? payload.reference ?? ''),
    access_code: row.access_code ? String(row.access_code) : undefined,
    authorization_url: row.authorization_url ? String(row.authorization_url) : undefined,
  };
}
