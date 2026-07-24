// RedFace Pay — Paystack Apple Pay domain registration (server-side only).
//
// Apple Pay domain registration is an account-level operation that requires the
// Paystack SECRET key, so it must run inside the Edge Function. Reads the key
// from the PAYSTACK_SECRET_KEY secret — never the browser.
//
// Merge these into your existing `redface-pay` action switch (see snippet below).

const PAYSTACK_BASE = 'https://api.paystack.co';

function secret(): string {
  const key = Deno.env.get('PAYSTACK_SECRET_KEY');
  if (!key) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  return key;
}

// POST /apple-pay/domain — register one top-level domain or subdomain.
export async function registerApplePayDomain(payload: { domainName?: string }) {
  const res = await fetch(`${PAYSTACK_BASE}/apple-pay/domain`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domainName: payload.domainName }),
  });
  return await res.json();
}

// GET /apple-pay/domain — list registered domains.
export async function listApplePayDomains() {
  const res = await fetch(`${PAYSTACK_BASE}/apple-pay/domain`, {
    headers: { Authorization: `Bearer ${secret()}` },
  });
  return await res.json();
}

// DELETE /apple-pay/domain — unregister a domain.
export async function unregisterApplePayDomain(payload: { domainName?: string }) {
  const res = await fetch(`${PAYSTACK_BASE}/apple-pay/domain`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domainName: payload.domainName }),
  });
  return await res.json();
}

/*
WIRING — add to your existing `redface-pay` switch on `action`:

  import { registerApplePayDomain, listApplePayDomains, unregisterApplePayDomain } from './apple-pay.ts';

  switch (action) {
    // ...existing cases...
    case 'applepay_register_domain':   return json(await registerApplePayDomain(body));
    case 'applepay_list_domains':      return json(await listApplePayDomains());
    case 'applepay_unregister_domain': return json(await unregisterApplePayDomain(body));
  }
*/
