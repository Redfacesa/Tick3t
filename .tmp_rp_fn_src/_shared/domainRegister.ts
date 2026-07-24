// Shared name.com domain registration (used by namecom + paystack-webhook).

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { namecomFetch } from './namecomClient.ts';
import { setupStoreDns, storeDnsTargets, useDefaultNameservers } from './domainDns.ts';
import {
  emailDomainRegistrationComplete,
  emailDomainRegistrationQueued,
  notifyAdminDomainPending,
} from './domainNotify.ts';

const NAMECOM_USER = Deno.env.get('NAMECOM_USERNAME') ?? '';
const NAMECOM_TOKEN = Deno.env.get('NAMECOM_API_TOKEN') ?? '';

export async function checkAvailability(domainName: string) {
  const res = await namecomFetch('/domains:checkAvailability', {
    method: 'POST',
    body: JSON.stringify({ domainNames: [domainName], purchaseType: 'registration' }),
  });
  if (!res.ok) return { ok: false, hit: null, error: res.data };
  const hit = (res.data as any)?.results?.[0] ?? null;
  return { ok: true, hit, error: null };
}

export function domainPaidButNotActive(row: { paid_at?: string | null; status?: string | null }): boolean {
  return !!row.paid_at && row.status !== 'active';
}

export async function mirrorUserDomainToMerchant(admin: SupabaseClient, userDomain: Record<string, unknown>) {
  if (!userDomain.merchant_id) return;
  await syncMerchantDomain(admin, userDomain, {
    status: userDomain.status,
    premium: userDomain.premium,
    purchase_price_usd: userDomain.purchase_price_usd,
    paid_at: userDomain.paid_at,
    paystack_reference: userDomain.paystack_reference,
    checkout_amount: userDomain.checkout_amount,
    checkout_currency: userDomain.checkout_currency,
    meta: userDomain.meta,
  });
}

export function registrationErrorMessage(data: unknown): string {
  const msg = String((data as any)?.message ?? (data as any)?.error ?? '').trim();
  const details = String((data as any)?.details ?? '').trim();
  const combined = `${msg} ${details}`.trim();
  if (/not enough balance|insufficient|payment failed/i.test(combined)) {
    return 'name.com credit is still too low to register this domain. Top up your name.com account balance, then refresh — we will retry automatically (you will not be charged again on Paystack).';
  }
  if (/insufficient/i.test(msg)) return 'name.com account credit is too low — top up and registration will retry automatically.';
  if (details) return `${msg || 'Registration failed'}: ${details}`;
  if (msg) return msg;
  return 'Registration could not be completed yet.';
}

const STALE_REGISTERING_MS = 3 * 60 * 1000;

function isStaleRegistering(row: { status?: string | null; updated_at?: string | null }): boolean {
  if (row.status !== 'registering') return false;
  const t = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  return !t || Date.now() - t > STALE_REGISTERING_MS;
}

/** Unstick rows left in `registering` after a crashed/timed-out attempt. */
export async function recoverStaleDomainRegistration(
  admin: SupabaseClient,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isStaleRegistering(row as { status?: string | null; updated_at?: string | null })) return row;
  const failPatch = {
    status: 'failed',
    meta: {
      ...((row.meta as Record<string, unknown>) || {}),
      register_error: { message: 'Registration timed out — will retry automatically' },
      registration_pending: true,
      recovered_from: 'registering',
      last_retry_at: new Date().toISOString(),
    },
  };
  await admin.from('user_domains').update(failPatch).eq('id', row.id as string);
  await syncMerchantDomain(admin, row, failPatch);
  return { ...row, ...failPatch };
}

async function buyerEmailForDomain(admin: SupabaseClient, row: Record<string, unknown>): Promise<string | null> {
  if (row.user_id) {
    const { data } = await admin.auth.admin.getUserById(row.user_id as string);
    const email = data?.user?.email?.toLowerCase();
    if (email) return email;
  }
  if (row.merchant_id) {
    const { data: m } = await admin.from('merchants').select('email').eq('id', row.merchant_id).maybeSingle();
    if (m?.email) return String(m.email).toLowerCase();
  }
  return null;
}

// Keep the linked merchant_domains row (if any) in sync with the canonical
// user_domains row so the merchant storefront DNS + email aliases keep working.
async function syncMerchantDomain(
  admin: SupabaseClient,
  userDomain: Record<string, unknown>,
  patch: Record<string, unknown>,
) {
  const merchantId = userDomain.merchant_id as string | null;
  if (!merchantId) return;

  const merchantPatch: Record<string, unknown> = {};
  if ('status' in patch) merchantPatch.status = patch.status;
  if ('is_primary' in patch) merchantPatch.is_primary = patch.is_primary;
  if ('namecom_order_id' in patch) merchantPatch.namecom_order_id = patch.namecom_order_id;
  if ('purchase_price_usd' in patch) merchantPatch.purchase_price_usd = patch.purchase_price_usd;
  if ('premium' in patch) merchantPatch.premium = patch.premium;
  if ('expiry_date' in patch) merchantPatch.expire_date = patch.expiry_date;
  if ('auto_renew' in patch) merchantPatch.autorenew_enabled = patch.auto_renew;
  if ('privacy_enabled' in patch) merchantPatch.privacy_enabled = patch.privacy_enabled;
  if ('dns_status' in patch) merchantPatch.dns_status = patch.dns_status;
  if ('dns_target' in patch) merchantPatch.dns_target = patch.dns_target;
  if ('dns_configured_at' in patch) merchantPatch.dns_configured_at = patch.dns_configured_at;
  if ('dns_records' in patch) merchantPatch.dns_records = patch.dns_records;
  if ('meta' in patch) merchantPatch.meta = patch.meta;
  if ('paid_at' in patch) merchantPatch.paid_at = patch.paid_at;
  if ('paystack_reference' in patch) merchantPatch.paystack_reference = patch.paystack_reference;
  if ('checkout_amount' in patch) merchantPatch.checkout_amount = patch.checkout_amount;
  if ('checkout_currency' in patch) merchantPatch.checkout_currency = patch.checkout_currency;
  if (!Object.keys(merchantPatch).length) return;

  // Upsert the merchant_domains row so a domain bought as a merchant always has
  // its storefront mirror, then keep the user_domain_id link.
  const { data: existing } = await admin
    .from('merchant_domains')
    .select('id')
    .eq('user_domain_id', userDomain.id as string)
    .maybeSingle();

  if (existing) {
    await admin.from('merchant_domains').update(merchantPatch).eq('id', existing.id);
  } else {
    await admin.from('merchant_domains').insert({
      merchant_id: merchantId,
      user_domain_id: userDomain.id as string,
      domain_name: userDomain.domain_name as string,
      ...merchantPatch,
    });
  }

  if (merchantPatch.is_primary === true) {
    await admin.from('merchant_domains')
      .update({ is_primary: false })
      .eq('merchant_id', merchantId)
      .neq('user_domain_id', userDomain.id as string);
  }
}

export async function registerDomainRow(
  admin: SupabaseClient,
  rowId: string,
  actorEmail = 'system',
): Promise<{ ok: boolean; message?: string; domain?: unknown }> {
  const { data: row } = await admin.from('user_domains').select('*').eq('id', rowId).maybeSingle();
  if (!row) return { ok: false, message: 'Domain row not found' };
  if (row.status === 'active') return { ok: true, domain: row, message: 'Already active' };

  const freshRow = await recoverStaleDomainRegistration(admin, row);
  if (freshRow.status === 'registering') {
    return { ok: false, message: 'Registration already in progress — refresh in a minute.' };
  }

  const check = await checkAvailability(freshRow.domain_name);
  const hit = check.hit;
  if (!check.ok || !hit?.purchasable || hit.purchaseType !== 'registration') {
    const failPatch = {
      status: 'failed',
      meta: { ...(freshRow.meta || {}), register_error: 'Domain no longer available' },
    };
    await admin.from('user_domains').update(failPatch).eq('id', freshRow.id);
    await syncMerchantDomain(admin, freshRow, failPatch);
    return { ok: false, message: 'Domain is no longer available for registration.' };
  }

  const idempotencyKey = freshRow.idempotency_key || crypto.randomUUID();
  await admin.from('user_domains').update({ status: 'registering', idempotency_key: idempotencyKey }).eq('id', freshRow.id);

  const createBody: Record<string, unknown> = {
    domain: { domainName: freshRow.domain_name, autorenewEnabled: true, privacyEnabled: true },
    purchaseType: 'registration',
    years: 1,
  };
  if (hit.premium && hit.purchasePrice != null) {
    createBody.purchasePrice = hit.purchasePrice;
  }

  let res: { ok: boolean; status: number; data: unknown };
  try {
    res = await namecomFetch('/domains', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': idempotencyKey },
      body: JSON.stringify(createBody),
    });
  } catch (err) {
    const failPatch = {
      status: 'failed',
      meta: {
        ...(freshRow.meta || {}),
        register_error: { message: err instanceof Error ? err.message : 'Network error' },
        registration_pending: true,
        last_retry_at: new Date().toISOString(),
        actor: actorEmail,
      },
    };
    await admin.from('user_domains').update(failPatch).eq('id', freshRow.id);
    await syncMerchantDomain(admin, freshRow, failPatch);
    return { ok: false, message: 'Could not reach name.com — try again shortly.' };
  }

  if (!res.ok) {
    const reason = registrationErrorMessage(res.data);
    const failPatch = {
      status: 'failed',
      meta: {
        ...(freshRow.meta || {}),
        register_error: res.data,
        registration_pending: true,
        last_retry_at: new Date().toISOString(),
        actor: actorEmail,
      },
    };
    await admin.from('user_domains').update(failPatch).eq('id', freshRow.id);
    await syncMerchantDomain(admin, freshRow, failPatch);
    if (freshRow.paid_at) {
      await notifyAdminDomainPending(
        admin,
        freshRow.domain_name as string,
        reason,
        (freshRow.merchant_id as string) ?? null,
      );
    }
    return { ok: false, message: reason };
  }

  const created = res.data as any;
  const domain = created.domain ?? {};
  const activePatch = {
    status: 'active',
    is_primary: true,
    namecom_order_id: created.order ?? null,
    purchase_price_usd: created.totalPaid ?? hit.purchasePrice ?? freshRow.purchase_price_usd,
    premium: !!hit.premium,
    purchase_date: new Date().toISOString(),
    expiry_date: domain.expireDate ?? null,
    auto_renew: domain.autorenewEnabled ?? true,
    privacy_enabled: domain.privacyEnabled ?? true,
    meta: { ...(freshRow.meta || {}), registered_at: new Date().toISOString(), actor: actorEmail },
  };
  await admin.from('user_domains').update(activePatch).eq('id', freshRow.id);

  // Ensure name.com nameservers so DNS/email can be managed in RedFace (not external registrar UI).
  await useDefaultNameservers(freshRow.domain_name as string);

  // Only one primary per owner.
  if (freshRow.user_id) {
    await admin.from('user_domains')
      .update({ is_primary: false })
      .eq('user_id', freshRow.user_id)
      .neq('id', freshRow.id);
  }

  // Record the service ownership (idempotent via unique (service_type, ref_id)).
  if (freshRow.user_id) {
    await admin.from('user_services')
      .upsert(
        { user_id: freshRow.user_id, service_type: 'domain', ref_id: freshRow.id, status: 'active' },
        { onConflict: 'service_type,ref_id' },
      );
  }

  const dns = await setupStoreDns(freshRow.domain_name);
  const dnsPatch = {
    dns_status: dns.ok ? 'configured' : 'failed',
    dns_target: dns.target ?? null,
    dns_configured_at: dns.ok ? new Date().toISOString() : null,
    dns_records: { results: dns.records ?? [], error: dns.ok ? null : dns.message },
    meta: {
      ...(freshRow.meta || {}),
      dns_setup: dns.ok ? 'auto' : 'failed',
      dns_message: dns.message ?? null,
    },
  };
  await admin.from('user_domains').update(dnsPatch).eq('id', freshRow.id);

  // Mirror everything onto the linked merchant storefront row.
  await syncMerchantDomain(admin, { ...freshRow, ...activePatch }, { ...activePatch, ...dnsPatch });

  const buyerEmail = await buyerEmailForDomain(admin, freshRow);
  if (buyerEmail) {
    await emailDomainRegistrationComplete(buyerEmail, freshRow.domain_name as string);
  }

  return { ok: true, domain: created.domain, dns };
}

/** Retry name.com registration for domains that were paid but are not active yet. */
export async function retryPaidDomainRegistrations(
  admin: SupabaseClient,
  rows: Array<{ id: string; status?: string | null; paid_at?: string | null; updated_at?: string | null }>,
  actorEmail: string,
  maxRetries = 1,
): Promise<{ retried: number; succeeded: number; lastError?: string }> {
  let retried = 0;
  let succeeded = 0;
  let lastError: string | undefined;

  const candidates = rows.filter((r) => domainPaidButNotActive(r));
  // Oldest stuck orders first.
  candidates.sort((a, b) => {
    const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return ta - tb;
  });

  for (const row of candidates) {
    if (retried >= maxRetries) break;
    if (row.status === 'registering' && !isStaleRegistering(row)) continue;
    retried += 1;
    const out = await registerDomainRow(admin, row.id, actorEmail);
    if (out.ok) succeeded += 1;
    else lastError = out.message;
  }
  return { retried, succeeded, lastError };
}

export { namecomFetch } from './namecomClient.ts';
