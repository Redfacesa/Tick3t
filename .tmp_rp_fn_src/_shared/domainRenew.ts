// Domain renewal + auto-renew at name.com (reseller API).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { domainCheckoutZar } from './domainCheckout.ts';
import { getDomainInfo } from './domainDns.ts';
import { namecomFetch } from './domainRegister.ts';
import {
  emailDomainAutoRenewFailed,
  emailDomainRenewalComplete,
} from './domainNotify.ts';

const PAYSTACK_SECRET = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';
const PAYSTACK_BASE = 'https://api.paystack.co';
const AUTO_CHARGE_DAYS_BEFORE = 14;

export type RenewalPricing = {
  renewalPriceUsd: number;
  checkoutAmountZar: number;
  currency: string;
  years: number;
  premium: boolean;
  mock?: boolean;
};

export type PaystackBilling = {
  authorization_code: string;
  email: string;
  card_type?: string;
  last4?: string;
  exp_month?: string;
  exp_year?: string;
  updated_at: string;
};

export type RenewalHistoryEntry = {
  at: string;
  years?: number;
  type?: 'registration' | 'renewal' | 'auto_renewal';
  paystack_reference?: string | null;
  checkout_amount?: number | null;
  checkout_currency?: string;
  renewal_price_usd?: number | null;
  actor?: string;
};

function parseRenewalUsd(data: unknown): number | null {
  const raw = data as Record<string, unknown>;
  const pricing = (raw.pricing ?? raw) as Record<string, unknown>;
  const price = Number(
    pricing.renewalPrice ?? pricing.renewal_price ?? pricing.purchasePrice ?? pricing.purchase_price ?? 0,
  );
  if (!Number.isFinite(price) || price <= 0) return null;
  return price;
}

export async function fetchRenewalPricing(domainName: string, years = 1): Promise<{
  ok: boolean;
  pricing?: RenewalPricing;
  message?: string;
}> {
  const name = domainName.trim().toLowerCase();
  const res = await namecomFetch(`/domains/${encodeURIComponent(name)}:getPricing?years=${years}`, { method: 'GET' });
  if (!res.ok) {
    return { ok: false, message: (res.data as any)?.message || 'Could not load renewal price.' };
  }
  const renewalPriceUsd = parseRenewalUsd(res.data);
  if (renewalPriceUsd == null) {
    return { ok: false, message: 'Renewal price unavailable for this domain.' };
  }
  const premium = !!(res.data as any)?.premium;
  return {
    ok: true,
    pricing: {
      renewalPriceUsd,
      checkoutAmountZar: domainCheckoutZar(renewalPriceUsd),
      currency: 'ZAR',
      years,
      premium,
    },
  };
}

export async function setDomainAutorenew(domainName: string, autorenewEnabled: boolean) {
  const res = await namecomFetch(`/domains/${encodeURIComponent(domainName.trim().toLowerCase())}`, {
    method: 'PATCH',
    body: JSON.stringify({ autorenewEnabled }),
  });
  if (!res.ok) {
    return { ok: false, message: (res.data as any)?.message || 'Could not update auto-renew setting.' };
  }
  const d = (res.data as any)?.domain ?? res.data ?? {};
  return {
    ok: true,
    autorenewEnabled: d.autorenewEnabled ?? autorenewEnabled,
    expireDate: d.expireDate ?? null,
  };
}

export async function getDomainTransferAuthCode(domainName: string) {
  const name = domainName.trim().toLowerCase();
  const res = await namecomFetch(`/domains/${encodeURIComponent(name)}:getAuthCode`, { method: 'GET' });
  if (!res.ok) {
    return {
      ok: false,
      message: (res.data as any)?.message || 'Could not retrieve transfer code. The domain may be locked — contact support.',
    };
  }
  const authCode = String((res.data as any)?.authCode ?? '').trim();
  if (!authCode) return { ok: false, message: 'Transfer code not available for this domain.' };
  return { ok: true, authCode };
}

export async function renewDomainAtRegistrar(
  domainName: string,
  years = 1,
  premiumRenewalPriceUsd?: number | null,
) {
  const name = domainName.trim().toLowerCase();
  const body: Record<string, unknown> = { years };
  if (premiumRenewalPriceUsd != null && premiumRenewalPriceUsd > 0) {
    body.purchasePrice = premiumRenewalPriceUsd;
  }
  const res = await namecomFetch(`/domains/${encodeURIComponent(name)}:renew`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = (res.data as any)?.message || 'Registrar renewal failed.';
    return { ok: false, message: msg, details: res.data };
  }
  const created = res.data as Record<string, unknown>;
  const domain = (created.domain ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    domain,
    expireDate: (domain.expireDate as string) ?? null,
    autorenewEnabled: domain.autorenewEnabled ?? null,
    order: created.order ?? null,
  };
}

export function buildRenewalHistory(row: Record<string, unknown>): RenewalHistoryEntry[] {
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  const history = Array.isArray(meta.renewal_history)
    ? (meta.renewal_history as RenewalHistoryEntry[])
    : [];
  const items: RenewalHistoryEntry[] = [];

  if (row.paid_at) {
    items.push({
      at: String(row.paid_at),
      years: 1,
      type: 'registration',
      paystack_reference: (row.paystack_reference as string) ?? null,
      checkout_amount: row.checkout_amount != null ? Number(row.checkout_amount) : null,
      checkout_currency: (row.checkout_currency as string) ?? 'ZAR',
      renewal_price_usd: row.purchase_price_usd != null ? Number(row.purchase_price_usd) : null,
      actor: 'initial purchase',
    });
  }

  items.push(...history);
  return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export function extractPaystackBilling(chargeData: Record<string, unknown>): PaystackBilling | null {
  const auth = chargeData.authorization as Record<string, unknown> | undefined;
  const code = String(auth?.authorization_code ?? '').trim();
  const customer = chargeData.customer as Record<string, unknown> | undefined;
  const email = String(customer?.email ?? chargeData.email ?? '').trim().toLowerCase();
  if (!code || !email) return null;
  return {
    authorization_code: code,
    email,
    card_type: auth?.card_type ? String(auth.card_type) : undefined,
    last4: auth?.last4 ? String(auth.last4) : undefined,
    exp_month: auth?.exp_month ? String(auth.exp_month) : undefined,
    exp_year: auth?.exp_year ? String(auth.exp_year) : undefined,
    updated_at: new Date().toISOString(),
  };
}

export async function savePaystackBillingForDomain(
  admin: SupabaseClient,
  domainRowId: string,
  chargeData: Record<string, unknown>,
) {
  const billing = extractPaystackBilling(chargeData);
  if (!billing) return;
  const { data: row } = await admin.from('user_domains').select('meta').eq('id', domainRowId).maybeSingle();
  if (!row) return;
  const meta = { ...((row.meta ?? {}) as Record<string, unknown>), paystack_billing: billing };
  await admin.from('user_domains').update({ meta }).eq('id', domainRowId);
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

async function paystackChargeAuthorization(
  billing: PaystackBilling,
  amountZar: number,
  reference: string,
  metadata: Record<string, unknown>,
) {
  if (!PAYSTACK_SECRET) return { ok: false, message: 'Paystack not configured.' };
  const res = await fetch(`${PAYSTACK_BASE}/transaction/charge_authorization`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: billing.email,
      amount: Math.round(amountZar * 100),
      currency: 'ZAR',
      authorization_code: billing.authorization_code,
      reference,
      metadata,
    }),
  });
  const data = await res.json();
  if (!data?.status) {
    return { ok: false, message: data?.message || 'Card charge failed.', data };
  }
  return { ok: true, data: data.data };
}

/** After Paystack confirms renewal payment, extend the domain at name.com. */
export async function renewDomainRow(
  admin: SupabaseClient,
  rowId: string,
  actorEmail = 'system',
  paystackReference?: string,
  historyType: RenewalHistoryEntry['type'] = 'renewal',
): Promise<{ ok: boolean; message?: string; domain?: unknown }> {
  const { data: row } = await admin.from('user_domains').select('*').eq('id', rowId).maybeSingle();
  if (!row) return { ok: false, message: 'Domain not found.' };
  if (row.status !== 'active') return { ok: false, message: 'Only active domains can be renewed.' };

  const meta = (row.meta ?? {}) as Record<string, unknown>;
  const pending = meta.renewal_checkout as Record<string, unknown> | undefined;
  const years = Number(pending?.years ?? 1) || 1;
  const renewalUsd = Number(pending?.renewal_price_usd ?? row.purchase_price_usd ?? 0);

  const reg = await renewDomainAtRegistrar(
    row.domain_name as string,
    years,
    row.premium ? renewalUsd : null,
  );
  if (!reg.ok) {
    const failMeta = {
      ...meta,
      renewal_error: { message: reg.message, at: new Date().toISOString(), actor: actorEmail },
    };
    await admin.from('user_domains').update({ meta: failMeta }).eq('id', rowId);
    return { ok: false, message: reg.message || 'Renewal failed at registrar.' };
  }

  let expireDate = reg.expireDate;
  if (!expireDate) {
    const info = await getDomainInfo(row.domain_name as string);
    expireDate = info.domain?.expireDate ?? row.expiry_date;
  }

  const history = Array.isArray(meta.renewal_history) ? [...meta.renewal_history] : [];
  history.push({
    at: new Date().toISOString(),
    years,
    type: historyType,
    paystack_reference: paystackReference ?? pending?.reference ?? null,
    checkout_amount: pending?.checkout_amount ?? null,
    checkout_currency: 'ZAR',
    renewal_price_usd: renewalUsd,
    actor: actorEmail,
  });

  const patch = {
    expiry_date: expireDate,
    auto_renew: reg.autorenewEnabled ?? row.auto_renew,
    meta: {
      ...meta,
      renewal_checkout: null,
      renewal_history: history,
      last_renewed_at: new Date().toISOString(),
      renewal_reminders: {},
    },
    updated_at: new Date().toISOString(),
  };
  await admin.from('user_domains').update(patch).eq('id', rowId);

  if (row.merchant_id) {
    await admin.from('merchant_domains').update({
      expire_date: expireDate,
      autorenew_enabled: patch.auto_renew,
      meta: patch.meta,
    }).eq('user_domain_id', rowId);
  }

  const buyerEmail = await buyerEmailForDomain(admin, row);
  if (buyerEmail && expireDate) {
    await emailDomainRenewalComplete(buyerEmail, row.domain_name as string, expireDate);
  }

  return { ok: true, message: `Renewed for ${years} year(s). New expiry: ${expireDate ?? 'updated'}.`, domain: reg.domain };
}

const REMINDER_DAYS = [30, 14, 7] as const;

/** Best-effort expiry reminders for domains with auto-renew off. */
export async function sendDomainRenewalReminders(admin: SupabaseClient): Promise<{ sent: number }> {
  const { emailDomainRenewalReminder } = await import('./domainNotify.ts');
  const now = Date.now();
  let sent = 0;

  const { data: rows } = await admin
    .from('user_domains')
    .select('id, user_id, merchant_id, domain_name, expiry_date, auto_renew, meta')
    .eq('status', 'active')
    .not('expiry_date', 'is', null);

  for (const row of rows ?? []) {
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    if (meta.auto_renew_paystack === true) continue;

    const expiry = new Date(row.expiry_date as string).getTime();
    if (!expiry || expiry <= now) continue;
    const daysLeft = Math.ceil((expiry - now) / 86400000);
    const match = REMINDER_DAYS.find((d) => daysLeft <= d && daysLeft > d - 2);
    if (!match) continue;

    const reminders = (meta.renewal_reminders ?? {}) as Record<string, string>;
    const key = `d${match}`;
    if (reminders[key]) continue;

    const email = await buyerEmailForDomain(admin, row);
    if (!email) continue;
    const ok = await emailDomainRenewalReminder(email, row.domain_name as string, row.expiry_date as string, daysLeft);
    if (!ok) continue;

    reminders[key] = new Date().toISOString();
    await admin.from('user_domains').update({
      meta: { ...meta, renewal_reminders: reminders },
    }).eq('id', row.id);
    sent += 1;
  }

  return { sent };
}

/** Charge saved Paystack card ~14 days before expiry when auto-renew billing is enabled. */
export async function processDomainAutoRenewals(admin: SupabaseClient): Promise<{ charged: number; failed: number }> {
  let charged = 0;
  let failed = 0;
  const now = Date.now();

  const { data: rows } = await admin
    .from('user_domains')
    .select('*')
    .eq('status', 'active')
    .not('expiry_date', 'is', null);

  for (const row of rows ?? []) {
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    if (meta.auto_renew_paystack !== true) continue;

    const billing = meta.paystack_billing as PaystackBilling | undefined;
    if (!billing?.authorization_code || !billing.email) continue;

    const expiry = new Date(row.expiry_date as string).getTime();
    if (!expiry || expiry <= now) continue;
    const daysLeft = Math.ceil((expiry - now) / 86400000);
    if (daysLeft > AUTO_CHARGE_DAYS_BEFORE || daysLeft < 1) continue;

    const autoKey = `auto_${row.expiry_date}`;
    const attempts = (meta.auto_renew_attempts ?? {}) as Record<string, string>;
    if (attempts[autoKey]) continue;

    const pricingOut = await fetchRenewalPricing(row.domain_name as string, 1);
    if (!pricingOut.ok || !pricingOut.pricing) {
      failed += 1;
      continue;
    }

    const reference = `rfa_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const checkout = {
      reference,
      years: 1,
      renewal_price_usd: pricingOut.pricing.renewalPriceUsd,
      checkout_amount: pricingOut.pricing.checkoutAmountZar,
      checkout_currency: 'ZAR',
      started_at: new Date().toISOString(),
      auto: true,
    };

    await admin.from('user_domains').update({
      meta: { ...meta, renewal_checkout: checkout },
    }).eq('id', row.id);

    const charge = await paystackChargeAuthorization(billing, pricingOut.pricing.checkoutAmountZar, reference, {
      purchase_type: 'domain_renewal',
      user_domain_row_id: row.id,
      domain_name: row.domain_name,
      auto_renewal: true,
    });

    if (!charge.ok) {
      failed += 1;
      attempts[autoKey] = new Date().toISOString();
      await admin.from('user_domains').update({
        meta: {
          ...meta,
          renewal_checkout: null,
          auto_renew_attempts: attempts,
          last_auto_renew_error: charge.message,
        },
      }).eq('id', row.id);
      const email = await buyerEmailForDomain(admin, row);
      if (email) {
        await emailDomainAutoRenewFailed(email, row.domain_name as string, charge.message || 'Payment failed');
      }
      continue;
    }

    const renew = await renewDomainRow(admin, row.id, 'auto-renew', reference, 'auto_renewal');
    if (renew.ok) {
      charged += 1;
      attempts[autoKey] = new Date().toISOString();
      const { data: fresh } = await admin.from('user_domains').select('meta').eq('id', row.id).maybeSingle();
      const freshMeta = { ...((fresh?.meta ?? {}) as Record<string, unknown>), auto_renew_attempts: attempts };
      await admin.from('user_domains').update({ meta: freshMeta }).eq('id', row.id);
      if (charge.data) await savePaystackBillingForDomain(admin, row.id, charge.data as Record<string, unknown>);
    } else {
      failed += 1;
    }
  }

  return { charged, failed };
}

export async function runDomainRenewalJobs(admin: SupabaseClient) {
  const reminders = await sendDomainRenewalReminders(admin);
  const auto = await processDomainAutoRenewals(admin);
  return { reminders, auto };
}
