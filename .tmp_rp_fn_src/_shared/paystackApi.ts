import { minChargeMessage, minChargeSubunits } from './paymentLimits.ts';

const PAYSTACK_BASE = 'https://api.paystack.co';

export async function paystackGet(secret: string, path: string) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.status === false) {
    return {
      ok: false,
      message: (json as { message?: string }).message || res.statusText,
      data: (json as { data?: unknown }).data,
    };
  }
  return { ok: true, data: (json as { data?: unknown }).data };
}

export async function paystackPost(secret: string, path: string, body: unknown) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.status === false) {
    return {
      ok: false,
      message: (json as { message?: string }).message || res.statusText,
      data: (json as { data?: unknown }).data,
    };
  }
  return { ok: true, data: (json as { data?: unknown }).data };
}

export async function paystackPut(secret: string, path: string, body: unknown) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.status === false) {
    return {
      ok: false,
      message: (json as { message?: string }).message || res.statusText,
      data: (json as { data?: unknown }).data,
    };
  }
  return { ok: true, data: (json as { data?: unknown }).data };
}

/** Master Paystack integration balance (major units, e.g. ZAR). */
export async function fetchPaystackBalance(secret: string) {
  const r = await paystackGet(secret, '/balance');
  if (!r.ok) return r;
  const rows = (r.data as Array<{ balance?: number; currency?: string }>) ?? [];
  const zar = rows.find((x) => String(x.currency ?? '').toUpperCase() === 'ZAR') ?? rows[0];
  const balanceSub = Number(zar?.balance ?? 0);
  return {
    ok: true,
    balance: balanceSub / 100,
    currency: String(zar?.currency ?? 'ZAR').toUpperCase(),
    raw: rows,
  };
}

export type CreateRecipientInput = {
  name: string;
  account_number: string;
  bank_code: string;
  currency?: string;
};

export async function createPaystackTransferRecipient(secret: string, input: CreateRecipientInput) {
  const currency = String(input.currency ?? 'ZAR').toUpperCase();
  const type = currency === 'ZAR' ? 'basa' : 'nuban';
  return await paystackPost(secret, '/transferrecipient', {
    type,
    name: input.name,
    account_number: input.account_number,
    bank_code: input.bank_code,
    currency,
  });
}

export type InitiateTransferInput = {
  amountMajor: number;
  recipientCode: string;
  reason: string;
  reference: string;
  currency?: string;
  merchantId?: string;
};

export async function initiatePaystackTransfer(secret: string, input: InitiateTransferInput) {
  const amountSub = Math.round(input.amountMajor * 100);
  if (amountSub < 100) {
    return { ok: false, message: 'Minimum transfer amount is R1.00' };
  }
  return await paystackPost(secret, '/transfer', {
    source: 'balance',
    amount: amountSub,
    recipient: input.recipientCode,
    reason: input.reason.slice(0, 100) || 'RedFace transfer',
    reference: input.reference,
    currency: String(input.currency ?? 'ZAR').toUpperCase(),
    metadata: input.merchantId ? { merchant_id: input.merchantId } : {},
  });
}

export type ChargeAuthorizationInput = {
  email: string;
  amountMajor: number;
  authorizationCode: string;
  reference: string;
  currency?: string;
  metadata?: Record<string, unknown>;
  subaccount?: string;
  splitCode?: string;
  transactionCharge?: number;
};

export async function chargePaystackAuthorization(secret: string, input: ChargeAuthorizationInput) {
  const amountSub = Math.round(input.amountMajor * 100);
  const currency = String(input.currency ?? 'ZAR').toUpperCase();
  const minSub = minChargeSubunits(currency);
  if (amountSub < minSub) {
    return { ok: false, message: minChargeMessage(currency) };
  }
  const body: Record<string, unknown> = {
    email: input.email,
    amount: amountSub,
    authorization_code: input.authorizationCode,
    reference: input.reference,
    currency: String(input.currency ?? 'ZAR').toUpperCase(),
    metadata: input.metadata ?? {},
  };
  if (input.splitCode) {
    body.split_code = input.splitCode;
  } else if (input.subaccount) {
    body.subaccount = input.subaccount;
    body.bearer = 'subaccount';
    if (input.transactionCharge && input.transactionCharge > 0) {
      body.transaction_charge = input.transactionCharge;
    }
  }
  return await paystackPost(secret, '/transaction/charge_authorization', body);
}

export type ChargeCardInput = {
  email: string;
  amountMajor: number;
  reference: string;
  currency?: string;
  card: {
    number: string;
    cvv: string;
    expiry_month: string;
    expiry_year: string;
  };
  metadata?: Record<string, unknown>;
  subaccount?: string;
  splitCode?: string;
  transactionCharge?: number;
};

/** Charge a card directly via Paystack — card data must never be logged or stored. */
export async function chargePaystackCard(secret: string, input: ChargeCardInput) {
  const amountSub = Math.round(input.amountMajor * 100);
  const currency = String(input.currency ?? 'ZAR').toUpperCase();
  const minSub = minChargeSubunits(currency);
  if (amountSub < minSub) {
    return { ok: false, message: minChargeMessage(currency) };
  }
  const body: Record<string, unknown> = {
    email: input.email,
    amount: amountSub,
    reference: input.reference,
    currency: String(input.currency ?? 'ZAR').toUpperCase(),
    card: {
      number: input.card.number.replace(/\D/g, ''),
      cvv: input.card.cvv.replace(/\D/g, ''),
      expiry_month: input.card.expiry_month.padStart(2, '0'),
      expiry_year: input.card.expiry_year.length === 2
        ? `20${input.card.expiry_year}`
        : input.card.expiry_year,
    },
    metadata: input.metadata ?? {},
  };
  if (input.splitCode) {
    body.split_code = input.splitCode;
  } else if (input.subaccount) {
    body.subaccount = input.subaccount;
    body.bearer = 'subaccount';
    if (input.transactionCharge && input.transactionCharge > 0) {
      body.transaction_charge = input.transactionCharge;
    }
  }
  return await paystackPost(secret, '/charge', body);
}

export async function createOrFetchPaystackCustomer(
  secret: string,
  input: { email: string; first_name: string; last_name: string; phone?: string | null },
) {
  const email = input.email.trim().toLowerCase();
  const existing = await paystackGet(secret, `/customer/${encodeURIComponent(email)}`);
  if (existing.ok) {
    const row = (existing.data ?? {}) as Record<string, unknown>;
    if (row.customer_code) return { ok: true, data: row };
  }
  return await paystackPost(secret, '/customer', {
    email,
    first_name: input.first_name,
    last_name: input.last_name,
    phone: input.phone || undefined,
  });
}

export type CreateDedicatedAccountInput = {
  customerCode: string;
  preferredBank?: string;
  subaccount?: string;
  splitCode?: string;
};

export async function createPaystackDedicatedAccount(secret: string, input: CreateDedicatedAccountInput) {
  const body: Record<string, unknown> = {
    customer: input.customerCode,
  };
  if (input.preferredBank) body.preferred_bank = input.preferredBank;
  if (input.splitCode) {
    body.split_code = input.splitCode;
  } else if (input.subaccount) {
    body.subaccount = input.subaccount;
  }
  return await paystackPost(secret, '/dedicated_account', body);
}

export async function listPaystackDvaProviders(secret: string, countryCode: 'NG' | 'GH' = 'NG') {
  return await paystackGet(secret, `/dedicated_account/available_providers?country=${countryCode}`);
}

export type InitializePreauthInput = {
  email: string;
  amountMajor: number;
  reference: string;
  currency?: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  subaccount?: string;
  splitCode?: string;
  transactionCharge?: number;
  expireAfterDays?: number;
  expireAction?: 'capture' | 'release';
};

export async function initializePaystackPreauthorization(secret: string, input: InitializePreauthInput) {
  const amountSub = Math.round(input.amountMajor * 100);
  const currency = String(input.currency ?? 'ZAR').toUpperCase();
  const minSub = minChargeSubunits(currency);
  if (amountSub < minSub) {
    return { ok: false, message: minChargeMessage(currency) };
  }
  const body: Record<string, unknown> = {
    email: input.email.trim().toLowerCase(),
    amount: String(amountSub),
    currency: String(input.currency ?? 'ZAR').toUpperCase(),
    reference: input.reference,
    metadata: input.metadata ?? {},
    expire_after_days: input.expireAfterDays ?? 7,
    expire_action: input.expireAction ?? 'release',
  };
  if (input.callbackUrl) body.callback_url = input.callbackUrl;
  if (input.splitCode) {
    body.split_code = input.splitCode;
  } else if (input.subaccount) {
    body.subaccount = input.subaccount;
    body.bearer = 'subaccount';
    if (input.transactionCharge && input.transactionCharge > 0) {
      body.transaction_charge = input.transactionCharge;
    }
  }
  return await paystackPost(secret, '/preauthorization/initialize', body);
}

export type ReservePreauthInput = {
  email: string;
  amountMajor: number;
  authorizationCode: string;
  reference?: string;
  currency?: string;
};

export async function reservePaystackPreauthorization(secret: string, input: ReservePreauthInput) {
  const amountSub = Math.round(input.amountMajor * 100);
  const currency = String(input.currency ?? 'ZAR').toUpperCase();
  const minSub = minChargeSubunits(currency);
  if (amountSub < minSub) {
    return { ok: false, message: minChargeMessage(currency) };
  }
  const body: Record<string, unknown> = {
    email: input.email.trim().toLowerCase(),
    amount: amountSub,
    authorization_code: input.authorizationCode,
    currency: String(input.currency ?? 'ZAR').toUpperCase(),
  };
  if (input.reference) body.reference = input.reference;
  return await paystackPost(secret, '/preauthorization/reserve_authorization', body);
}

export async function capturePaystackPreauthorization(
  secret: string,
  input: { reference: string; amountMajor: number; currency?: string },
) {
  const amountSub = Math.round(input.amountMajor * 100);
  return await paystackPost(secret, '/preauthorization/capture', {
    reference: input.reference,
    currency: String(input.currency ?? 'ZAR').toUpperCase(),
    amount: String(amountSub),
  });
}

export async function releasePaystackPreauthorization(secret: string, reference: string) {
  return await paystackPost(secret, '/preauthorization/release', { reference });
}

export async function disablePaystackSubscription(secret: string, subscriptionCode: string) {
  return await paystackPost(secret, '/subscription/disable', { code: subscriptionCode });
}

export async function fetchPaystackDispute(secret: string, disputeId: number | string) {
  return await paystackGet(secret, `/dispute/${encodeURIComponent(String(disputeId))}`);
}

export async function getPaystackDisputeUploadUrl(
  secret: string,
  disputeId: number | string,
  extension: string,
) {
  const ext = extension.replace(/^\./, '').toLowerCase() || 'pdf';
  return await paystackGet(secret, `/dispute/${encodeURIComponent(String(disputeId))}/upload_url?extension=${encodeURIComponent(ext)}`);
}

export async function resolvePaystackDispute(
  secret: string,
  disputeId: number | string,
  input: {
    message: string;
    resolution: 'merchant-accepted' | 'declined';
    refund_amount?: string;
    uploaded_filename?: string;
  },
) {
  return await paystackPut(secret, `/dispute/${encodeURIComponent(String(disputeId))}/resolve`, input);
}
