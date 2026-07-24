/**
 * Merchant Capabilities API — registry-driven discovery (Capability Registry v1).
 *
 * Merchants buy outcomes; developers buy kernels. Response uses merchant-facing
 * keys only. Each capability is a feature contract: enabled + why/why not.
 *
 * @see docs/codex/platform/financial-abstraction-layer.md
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  CAPABILITY_REGISTRY,
  type CapabilityDescriptor,
  type ProcessingRail,
  selectProcessingRail,
} from './paymentRouting.ts';
import { listPaymentTerminals, type PaymentTerminal } from './paymentTerminal.ts';

export type CapabilityState = {
  enabled: boolean;
  status: 'active' | 'unavailable' | 'planned';
  configured: boolean;
  requirements: string[];
  reason: string | null;
};

export type MerchantCapabilityMap = {
  paymentLinks: CapabilityState;
  qr: CapabilityState;
  nfcTap: CapabilityState;
  manualCard: CapabilityState;
  checkout: CapabilityState;
  tablePay: CapabilityState;
  cash: CapabilityState;
  storeCredit: CapabilityState;
  cardPayments: CapabilityState;
  bankTransfer: CapabilityState;
  crypto: CapabilityState;
  voiceCharge: CapabilityState;
  appleTap: CapabilityState;
  softpos: CapabilityState;
};

/** Flat booleans for simple UI checks. Prefer CapabilityState when showing reasons. */
export type MerchantCapabilityFlags = {
  [K in keyof MerchantCapabilityMap]: boolean;
};

export type MerchantCapabilitiesResponse = {
  merchant_id: string;
  country: string | null;
  currency: string;
  capabilities: MerchantCapabilityMap;
  /** Convenience booleans derived from capabilities.*.enabled */
  flags: MerchantCapabilityFlags;
  default_rails: Partial<Record<string, ProcessingRail>>;
  /** SoftPOS-ready terminals (NFC cards, SoftPOS, QR, cash, link). */
  terminals: PaymentTerminal[];
  registry: Array<CapabilityDescriptor & { available: boolean; missing_requirements: string[] }>;
};

type MerchantRow = {
  id: string;
  country: string | null;
  status: string;
  paystack_subaccount: string | null;
  paystack_split_code: string | null;
};

const REASON_LABEL: Record<string, string> = {
  merchant_approved: 'Business is not approved yet',
  country: 'Not available in this country',
  paystack_subaccount: 'Card payments are not set up yet',
  payment_object: 'No active terminal or NFC tag',
  store_credit_program: 'No active store credit issued yet',
  tap_partner_onboarding: 'Partner onboarding has not been completed',
  ios_device: 'Requires a compatible iPhone',
  planned: 'Coming soon',
  restaurant_tables: 'Floor tables are not set up',
  dedicated_account: 'Dedicated bank account is not active',
  crypto_wallets: 'Crypto wallets are not configured',
};

function hasPaystackRoute(m: MerchantRow): boolean {
  return String(m.paystack_split_code || m.paystack_subaccount || '').trim().length > 0;
}

function countryAllowed(desc: CapabilityDescriptor, country: string | null): boolean {
  if (desc.countries === 'all') return true;
  const c = String(country ?? '').trim().toUpperCase();
  return desc.countries.some((x) => x.toUpperCase() === c);
}

function evaluateDescriptor(
  desc: CapabilityDescriptor,
  ctx: {
    merchant: MerchantRow;
    hasPaymentObject: boolean;
    hasTables: boolean;
    hasStoreCreditProgram: boolean;
    hasDedicatedAccount: boolean;
    hasCrypto: boolean;
  },
): { available: boolean; missing: string[] } {
  const missing: string[] = [];
  if (ctx.merchant.status !== 'approved') missing.push('merchant_approved');
  if (!countryAllowed(desc, ctx.merchant.country)) missing.push('country');

  for (const req of desc.requirements) {
    if (req === 'paystack_subaccount' && !hasPaystackRoute(ctx.merchant)) missing.push(req);
    if (req === 'payment_object' && !ctx.hasPaymentObject) missing.push(req);
    if (req === 'store_credit_program' && !ctx.hasStoreCreditProgram) missing.push(req);
    if (req === 'dedicated_account' && !ctx.hasDedicatedAccount) missing.push(req);
    if (req === 'crypto_wallets' && !ctx.hasCrypto) missing.push(req);
    if (req === 'tap_partner_onboarding') missing.push(req);
    if (req === 'ios_device') missing.push(req);
  }

  if (desc.id === 'store_credit_rail' || desc.id === 'store_credit_capture') {
    if (!ctx.hasStoreCreditProgram) missing.push('store_credit_program');
  }
  if (desc.status === 'planned') missing.push('planned');

  return { available: missing.length === 0, missing: [...new Set(missing)] };
}

function toState(
  enabled: boolean,
  missing: string[],
  opts: { planned?: boolean; configured?: boolean } = {},
): CapabilityState {
  const requirements = missing.filter((m) => m !== 'planned' && m !== 'merchant_approved');
  const primary = missing[0] ?? null;
  return {
    enabled,
    status: opts.planned || missing.includes('planned')
      ? 'planned'
      : enabled
        ? 'active'
        : 'unavailable',
    configured: opts.configured ?? enabled,
    requirements,
    reason: enabled ? null : (primary ? (REASON_LABEL[primary] ?? primary) : 'Unavailable'),
  };
}

function flagsFromMap(map: MerchantCapabilityMap): MerchantCapabilityFlags {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, (v as CapabilityState).enabled]),
  ) as MerchantCapabilityFlags;
}

export async function resolveMerchantCapabilities(
  admin: SupabaseClient,
  merchantId: string,
): Promise<{ ok: true; data: MerchantCapabilitiesResponse } | { ok: false; error: string }> {
  const id = String(merchantId ?? '').trim();
  if (!id) return { ok: false, error: 'merchant_id_required' };

  const { data: merchant, error } = await admin
    .from('merchants')
    .select('id, country, status, paystack_subaccount, paystack_split_code')
    .eq('id', id)
    .maybeSingle();
  if (error || !merchant) return { ok: false, error: 'merchant_not_found' };

  const [
    { count: poCount },
    { count: tableCount },
    { count: creditCount },
    { count: dedicatedCount },
    { data: cryptoRow },
  ] = await Promise.all([
    admin.from('payment_objects').select('id', { count: 'exact', head: true })
      .eq('merchant_id', id).eq('status', 'active'),
    admin.from('restaurant_tables').select('id', { count: 'exact', head: true })
      .eq('merchant_id', id),
    admin.from('merchant_store_credits').select('id', { count: 'exact', head: true })
      .eq('merchant_id', id).eq('status', 'active'),
    admin.from('merchant_dedicated_accounts').select('id', { count: 'exact', head: true })
      .eq('merchant_id', id).eq('status', 'active'),
    admin.from('merchant_crypto_settings').select('enabled, btc_address, eth_address, usdt_trc20_address, usdt_erc20_address')
      .eq('merchant_id', id).maybeSingle(),
  ]);

  const hasCrypto = Boolean(
    cryptoRow?.enabled
    && (cryptoRow.btc_address || cryptoRow.eth_address || cryptoRow.usdt_trc20_address || cryptoRow.usdt_erc20_address),
  );

  const ctx = {
    merchant: merchant as MerchantRow,
    hasPaymentObject: (poCount ?? 0) > 0,
    hasTables: (tableCount ?? 0) > 0,
    hasStoreCreditProgram: (creditCount ?? 0) > 0,
    hasDedicatedAccount: (dedicatedCount ?? 0) > 0,
    hasCrypto,
  };

  const country = merchant.country ?? null;
  const currency = country === 'NG' ? 'NGN' : country === 'GH' ? 'GHS' : country === 'KE' ? 'KES' : 'ZAR';

  const registry = CAPABILITY_REGISTRY.map((desc) => {
    const { available, missing } = evaluateDescriptor(desc, ctx);
    return { ...desc, available, missing_requirements: missing };
  });

  const byId = (capId: string) => registry.find((r) => r.id === capId);

  const paymentLink = byId('payment_link_capture');
  const qr = byId('qr_capture');
  const nfc = byId('nfc_tap_capture');
  const manual = byId('manual_card_capture');
  const cash = byId('cash_capture');
  const storeCredit = byId('store_credit_capture') ?? byId('store_credit_rail');
  const paystack = byId('paystack_rail');
  const apple = byId('apple_tap_capture');
  const softpos = byId('softpos_capture');
  const bank = byId('bank_transfer_capture');
  const crypto = byId('crypto_capture');

  const cardPayments = paystack?.available ?? false;

  const capabilities: MerchantCapabilityMap = {
    paymentLinks: toState(paymentLink?.available ?? false, paymentLink?.missing_requirements ?? []),
    qr: toState(qr?.available ?? false, qr?.missing_requirements ?? []),
    nfcTap: toState(nfc?.available ?? false, nfc?.missing_requirements ?? [], {
      configured: ctx.hasPaymentObject,
    }),
    manualCard: toState(
      (manual?.available ?? false) && cardPayments,
      [...(manual?.missing_requirements ?? []), ...(cardPayments ? [] : ['paystack_subaccount'])],
    ),
    checkout: toState(cardPayments || (paymentLink?.available ?? false), cardPayments ? [] : ['paystack_subaccount']),
    tablePay: toState(
      ctx.hasTables && (paymentLink?.available ?? false),
      ctx.hasTables ? (paymentLink?.missing_requirements ?? []) : ['restaurant_tables'],
      { configured: ctx.hasTables },
    ),
    cash: toState(cash?.available ?? false, cash?.missing_requirements ?? []),
    storeCredit: toState(storeCredit?.available ?? false, storeCredit?.missing_requirements ?? [], {
      configured: ctx.hasStoreCreditProgram,
    }),
    cardPayments: toState(cardPayments, paystack?.missing_requirements ?? [], {
      configured: hasPaystackRoute(merchant as MerchantRow),
    }),
    bankTransfer: toState(bank?.available ?? false, bank?.missing_requirements ?? [], {
      configured: ctx.hasDedicatedAccount,
    }),
    crypto: toState(crypto?.available ?? false, crypto?.missing_requirements ?? [], {
      configured: hasCrypto,
    }),
    voiceCharge: toState(paymentLink?.available ?? false, paymentLink?.missing_requirements ?? []),
    appleTap: toState(apple?.available ?? false, apple?.missing_requirements ?? [], { planned: true }),
    softpos: toState(softpos?.available ?? false, softpos?.missing_requirements ?? [], { planned: true }),
  };

  const default_rails: Partial<Record<string, ProcessingRail>> = {
    payment_link: selectProcessingRail({ merchantId: id, currency, country, captureMethod: 'payment_link' }).rail,
    nfc_tap: selectProcessingRail({ merchantId: id, currency, country, captureMethod: 'nfc_tap' }).rail,
    cash: selectProcessingRail({ merchantId: id, currency, country, captureMethod: 'cash' }).rail,
    store_credit: selectProcessingRail({ merchantId: id, currency, country, captureMethod: 'store_credit' }).rail,
    softpos: selectProcessingRail({ merchantId: id, currency, country, captureMethod: 'softpos' }).rail,
    apple_tap: selectProcessingRail({ merchantId: id, currency, country, captureMethod: 'apple_tap' }).rail,
  };

  const terminals = await listPaymentTerminals(admin, id, { includeSynthetic: true });

  return {
    ok: true,
    data: {
      merchant_id: id,
      country,
      currency,
      capabilities,
      flags: flagsFromMap(capabilities),
      default_rails,
      terminals,
      registry,
    },
  };
}
