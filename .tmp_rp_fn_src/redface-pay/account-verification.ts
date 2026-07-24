// RedFace Pay — bank verification + checkout verify (server-side only).
//
// IMPORTANT: the Paystack SECRET key must NEVER reach the browser. Set it as a
// Supabase Edge Function secret and read it here:
//
//   supabase secrets set PAYSTACK_SECRET_KEY=sk_live_xxx   (use a freshly rotated key)
//
// Checkout verify goes through PaymentProvider (Paystack adapter today).
// Bank list/resolve/validate remain Paystack-specific until Phase 4.

import { getPaymentProvider, verifyResultToLegacyEnvelope } from '../_shared/paymentProvider/index.ts';

const PAYSTACK_BASE = 'https://api.paystack.co';

function secret(): string {
  const key = Deno.env.get('PAYSTACK_SECRET_KEY');
  if (!key) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  return key;
}

async function paystackGet(path: string) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    headers: { Authorization: `Bearer ${secret()}` },
  });
  return await res.json();
}

/** Verify a checkout reference via the active PaymentProvider (Paystack today). */
export async function verifyPaystackTransaction(reference: string) {
  const result = await getPaymentProvider().verifyTransaction(reference);
  return verifyResultToLegacyEnvelope(result);
}

async function paystackPost(path: string, body: unknown) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json();
}

function friendlyPaystackBankError(message: string): string {
  const m = message.trim();
  if (/insufficient balance/i.test(m)) {
    return 'Paystack account balance is too low for bank validation. Top up your Paystack balance in the Paystack Dashboard, or ask an admin to verify the bank account manually.';
  }
  return m || 'Bank verification failed';
}

function wrapPaystackBankResult(result: Record<string, unknown>) {
  if (result?.status === false) {
    const msg = friendlyPaystackBankError(String(result.message ?? ''));
    return { status: false, message: msg, paystack: result };
  }
  return result;
}

// GET /bank — list banks for a currency. For ZAR account validation, pass
// enabled_for_verification=true to get only banks that support validation.
export async function listBanks(payload: { currency?: string; enabled_for_verification?: boolean }) {
  const params = new URLSearchParams();
  params.set('currency', payload.currency || 'ZAR');
  if (payload.enabled_for_verification) params.set('enabled_for_verification', 'true');
  params.set('perPage', '100');
  return await paystackGet(`/bank?${params.toString()}`);
}

// GET /bank/resolve — Nigeria & Ghana: confirm a personal bank account.
export async function resolveAccount(payload: { account_number?: string; bank_code?: string }) {
  const params = new URLSearchParams();
  params.set('account_number', payload.account_number || '');
  params.set('bank_code', payload.bank_code || '');
  return wrapPaystackBankResult(await paystackGet(`/bank/resolve?${params.toString()}`) as Record<string, unknown>);
}

// POST /bank/validate — South Africa: validate personal/business accounts.
export async function validateAccount(payload: {
  account_name?: string;
  account_number?: string;
  account_type?: string;       // personal | business
  bank_code?: string;
  country_code?: string;       // e.g. ZA
  document_type?: string;      // identityNumber | passportNumber | businessRegistrationNumber
  document_number?: string;
}) {
  return wrapPaystackBankResult(await paystackPost('/bank/validate', {
    account_name: payload.account_name,
    account_number: payload.account_number,
    account_type: payload.account_type,
    bank_code: payload.bank_code,
    country_code: payload.country_code,
    document_type: payload.document_type,
    document_number: payload.document_number,
  }) as Record<string, unknown>);
}

/*
WIRING — add these cases to your existing `redface-pay` switch on `action`,
keeping your current CORS handling and the same JSON response shape you already
use for init_payment/confirm_payment:

  import { listBanks, resolveAccount, validateAccount } from './account-verification.ts';

  // inside your serve() handler, after parsing `const { action, ...body } = await req.json();`
  switch (action) {
    // ...your existing cases (create_subaccount, init_payment, confirm_payment)...

    case 'list_banks':
      return json(await listBanks(body));

    case 'resolve_account':
      return json(await resolveAccount(body));

    case 'validate_account':
      return json(await validateAccount(body));
  }

where `json(x)` is your existing helper that returns `new Response(JSON.stringify(x), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })`.
*/
