const PAYSTACK_BASE = 'https://api.paystack.co';

export function friendlyRefundError(message: string): string {
  const m = message.trim();
  if (/insufficient balance/i.test(m)) {
    return 'Paystack balance is too low to process this refund. Top up your Paystack account and try again.';
  }
  if (/fully reversed/i.test(m)) {
    return 'This payment has already been fully refunded.';
  }
  return m || 'Paystack refund failed';
}

export type PaystackRefundInput = {
  transactionReference: string;
  amountMajor: number;
  currency?: string;
  customerNote?: string;
  merchantNote?: string;
  secret: string;
};

export type PaystackRefundResult =
  | { ok: true; paystackId: string; paystackStatus: string; raw: Record<string, unknown> }
  | { ok: false; message: string; raw: Record<string, unknown> };

export async function createPaystackRefund(input: PaystackRefundInput): Promise<PaystackRefundResult> {
  const amountSubunits = Math.round(Number(input.amountMajor) * 100);
  if (!input.transactionReference) {
    return { ok: false, message: 'Transaction reference is required', raw: {} };
  }
  if (!amountSubunits || amountSubunits <= 0) {
    return { ok: false, message: 'Refund amount must be positive', raw: {} };
  }

  const body: Record<string, unknown> = {
    transaction: input.transactionReference,
    amount: amountSubunits,
  };
  if (input.currency) body.currency = input.currency;
  if (input.customerNote) body.customer_note = input.customerNote;
  if (input.merchantNote) body.merchant_note = input.merchantNote;

  const res = await fetch(`${PAYSTACK_BASE}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = (await res.json()) as Record<string, unknown>;
  if (!raw.status) {
    return {
      ok: false,
      message: friendlyRefundError(String(raw.message ?? 'Paystack refund failed')),
      raw,
    };
  }

  const data = (raw.data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    paystackId: String(data.id ?? ''),
    paystackStatus: String(data.status ?? 'pending'),
    raw,
  };
}
