// RedFace Pay — primary Edge Function (the action router the whole app calls).
//
// The browser never talks to Paystack directly. Every privileged call goes
// through supabase.functions.invoke('redface-pay', { body: { action, ... } }),
// so the Paystack SECRET key stays server-side (read from PAYSTACK_SECRET_KEY).
//
// SETUP
//   1. Set the secret (use your freshly ROTATED live key):
//        supabase secrets set PAYSTACK_SECRET_KEY=sk_live_xxx
//      Pricing is plan-based on the merchants table:
//        small = 2%, marketplace = 5%, premium = 0% while subscribed
//      Optional: where Paystack returns the customer after checkout:
//        supabase secrets set APP_URL=https://redfacepay.co.za
//      SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//   2. Deploy:
//        supabase functions deploy redface-pay
//
// Actions handled (matched to the frontend callers):
//   init_payment, confirm_payment            (src/components/PaymentPage.tsx)
//   init_domain_payment, init_plan_subscription, init_studio_subscription, confirm_studio_subscription
//   create_subaccount                        (src/components/AdminPanel.tsx)
//   list_banks, resolve_account,             (src/lib/banks.ts)
//     validate_account
//   applepay_register_domain,                (src/lib/paystackAdmin.ts)
//     applepay_list_domains,
//     applepay_unregister_domain
//   process_refund                           (MerchantWallet, AdminPanel)
//   process_abandoned_cart_reminders         (pg_cron hourly + AdminPanel)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  developerTierAmountZar,
  isPaidDeveloperTier,
  type PaidDeveloperTier,
} from '../_shared/developerApiBilling.ts';
import { listBanks, resolveAccount, validateAccount, verifyPaystackTransaction } from './account-verification.ts';
import { authorizeCron, requireAdminFromRequest } from '../_shared/adminAccess.ts';
import {
  registerApplePayDomain,
  listApplePayDomains,
  unregisterApplePayDomain,
} from './apple-pay.ts';
import { checkAvailability } from '../_shared/domainRegister.ts';
import { appendPlatformPaymentEvent } from '../_shared/platformPaymentSpine.ts';
import { emitMerchantBusinessEvent } from '../_shared/businessEvents.ts';
import { DEFAULT_NOTIFY_FROM, DEFAULT_NOTIFY_TO, PLATFORM_INFO_EMAIL } from '../_shared/platformEmail.ts';
import { bossAlertHtml, notifyBoss, type BossEvent } from '../_shared/bossNotify.ts';
import { activeProviderName, getPaymentProvider } from '../_shared/paymentProvider/index.ts';
import { initializePaystackCheckoutFull } from '../_shared/paymentProvider/paystack.ts';
import { provisionMerchantPayouts, tryAutoApproveMerchant } from '../_shared/merchantAutoApprove.ts';
import { sendSignupVerificationEmail } from '../_shared/signupEmailVerification.ts';
import {
  captureFareAuthorization,
  createFareAuthorization,
  buildFarePreauthReference,
  releaseFareAuthorization,
} from '../_shared/fareAuthorizations.ts';
import { freePlanPatch } from '../_shared/aiSubscription.ts';
import { defaultPlanPercent, feePlanFromMerchant, type MerchantPlan } from '../_shared/feePlan.ts';
import { fetchPaystackBalance, createPaystackTransferRecipient, initiatePaystackTransfer, chargePaystackAuthorization, chargePaystackCard, createOrFetchPaystackCustomer, createPaystackDedicatedAccount, initializePaystackPreauthorization, reservePaystackPreauthorization, disablePaystackSubscription, getPaystackDisputeUploadUrl, resolvePaystackDispute } from '../_shared/paystackApi.ts';
import { assertCardAmountViable, minCardAmountMessage } from '../_shared/paymentLimits.ts';

import { domainCheckoutZar } from '../_shared/domainCheckout.ts';
import { fetchRenewalPricing } from '../_shared/domainRenew.ts';
import { createOrderFromPayment } from '../_shared/orderCreate.ts';
import { processAbandonedCartReminders } from '../_shared/abandonedCart.ts';
import { createPaystackRefund } from '../_shared/paystackRefund.ts';
import {
  normalizeSponsoredDays,
  sponsoredListingPrice,
  sponsoredPlanCode,
} from '../_shared/sponsoredListings.ts';
import {
  normalizeStudioPlanId,
  studioAmountMajor,
  studioPaystackPlanCode,
} from '../_shared/studioBilling.ts';
import { applyStudioBillingWebhook, isStudioPaystackMetadata } from '../_shared/studioWebhook.ts';
import {
  cancelOpenSessions,
  markSessionFailed,
  markSessionPaid,
  reopenPaymentSession,
  validatePaymentSessionForInit,
  createPaymentSessionRecord,
  cartLabel,
  resolveCartItems,
  type PaymentSessionRow,
} from '../_shared/paymentSessions.ts';
import { recordPaymentLedgerEntry } from '../_shared/ledgerEngine.ts';
import { resolveMerchantCapabilities } from '../_shared/merchantCapabilities.ts';
import {
  resolveMultiVendorCart,
  marketplaceCartLabel,
} from '../_shared/resolveMultiVendorCart.ts';
import {
  buildPaystackFlatSplit,
  computeVendorPricing,
  fanOutMarketplaceCheckoutSuccess,
} from '../_shared/marketplaceCheckout.ts';
import {
  redeemStoreCreditIfNeeded,
  resolveStoreCreditForCheckout,
  splitStoreCreditAmount,
} from '../_shared/storeCredits.ts';
import {
  resolveInvoiceCheckout,
  applyInvoicePayment,
  type InvoicePaymentKind,
} from '../_shared/invoiceCheckout.ts';
import {
  completePaymentRequest,
  ensureIdempotencyKey,
  readIdempotencyKey,
  resolveCheckoutIdentity,
  tryResumeCompletedRequest,
  type CheckoutIdentity,
} from '../_shared/idempotency.ts';
import { requireMerchantById } from '../_shared/merchantAccess.ts';
import { isAdminEmail } from '../_shared/adminAccess.ts';

const PAYSTACK_BASE = 'https://api.paystack.co';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const APP_URL = Deno.env.get('APP_URL') ?? 'https://redfacepay.co.za';

// Admin notification email (Resend). RESEND_API_KEY is optional — without it the
// in-app notification + audit log still happen, only the email is skipped.
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const NOTIFY_TO = Deno.env.get('NOTIFY_TO') ?? DEFAULT_NOTIFY_TO;
const NOTIFY_FROM = Deno.env.get('NOTIFY_FROM') ?? DEFAULT_NOTIFY_FROM;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

const requireAdmin = (req: Request) => requireAdminFromRequest(admin, req);

type ActingMerchant = {
  email: string;
  merchant: {
    id: string;
    business_name: string;
    email: string;
    status: string;
    country?: string;
  };
};

/** Owner, staff, platform admin, or Entendre ecosystem admin → act as that merchant. */
async function resolveActingMerchant(
  req: Request,
  preferredMerchantId?: string,
): Promise<{ who: ActingMerchant | null; error?: string; status?: number }> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { who: null, error: 'Sign in required.', status: 401 };

  const { data: authData, error: authErr } = await admin.auth.getUser(token);
  const email = authData?.user?.email?.toLowerCase();
  if (authErr || !email) return { who: null, error: 'Sign in required.', status: 401 };

  const preferred = String(preferredMerchantId ?? '').trim();
  const byEmail = await requireMerchant(req);

  const toWho = (row: Record<string, unknown>): ActingMerchant => ({
    email,
    merchant: {
      id: String(row.id),
      business_name: String(row.business_name ?? ''),
      email: String(row.email ?? email),
      status: String(row.status ?? 'approved'),
      country: row.country != null ? String(row.country) : undefined,
    },
  });

  if (preferred) {
    const byId = await requireMerchantById(admin, req, preferred);
    const platformAdmin = await isAdminEmail(admin, email);

    let ecosystemAdmin = false;
    if (!byId && !platformAdmin) {
      const { data: apps } = await admin
        .from('platform_ecosystem_apps')
        .select('admin_emails, pay_merchant_id')
        .eq('pay_merchant_id', preferred)
        .eq('active', true);
      ecosystemAdmin = (apps ?? []).some((app) => {
        const emails = Array.isArray(app.admin_emails) ? app.admin_emails : [];
        return emails.map((e: unknown) => String(e).toLowerCase()).includes(email);
      });
    }

    if (byId || platformAdmin || ecosystemAdmin) {
      let row: Record<string, unknown> | null = byId as Record<string, unknown> | null;
      if (!row) {
        const { data } = await admin
          .from('merchants')
          .select('id, business_name, email, status, country')
          .eq('id', preferred)
          .maybeSingle();
        row = data as Record<string, unknown> | null;
      }
      if (!row) return { who: null, error: 'Merchant not found.', status: 404 };
      if (String(row.status) === 'rejected') {
        return { who: null, error: 'Merchant is not approved.', status: 403 };
      }
      return { who: toWho(row) };
    }

    if (byEmail && byEmail.merchant.id === preferred) {
      return { who: byEmail as ActingMerchant };
    }

    return {
      who: null,
      error:
        'Not authorised for this merchant. Use 3ntendr3@gmail.com or info@redfacepay.co.za on Entendre admin.',
      status: 401,
    };
  }

  return { who: (byEmail as ActingMerchant | null) ?? null, error: byEmail ? undefined : 'Sign in as an approved merchant.', status: byEmail ? undefined : 401 };
}

async function requireMerchant(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) return null;
  const { data: merchant } = await admin
    .from('merchants')
    .select('id, business_name, email, status, country')
    .ilike('email', email)
    .maybeSingle();
  if (!merchant || merchant.status !== 'approved') return null;
  return { email, merchant };
}

// Any signed-in auth user (need not be a merchant). Resolves a linked merchant
// opportunistically so a merchant buying a domain also gets the storefront link.
async function requireUser(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  const userId = data?.user?.id;
  const email = data?.user?.email?.toLowerCase();
  if (error || !userId || !email) return null;
  const { data: merchant } = await admin
    .from('merchants')
    .select('id, business_name, email, status, country')
    .ilike('email', email)
    .maybeSingle();
  return { userId, email, merchant: merchant ?? null };
}


const PREMIUM_SUBSCRIPTION_ZAR = Number(Deno.env.get('PREMIUM_SUBSCRIPTION_ZAR') ?? '299');
const PREMIUM_PLAN_CODE = Deno.env.get('PREMIUM_PLAN_CODE') ?? 'PLN_puycslmqhr2r3fz';
// Paystack subaccount: % of each payment routed to the platform account.
const PLATFORM_FEE_PERCENT = Number(Deno.env.get('PLATFORM_FEE_PERCENT') ?? '2');

// CORS: the browser does a preflight because invoke sends Authorization +
// Content-Type headers. Allow any origin (the function is the trust boundary).
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function secret(): string {
  const key = Deno.env.get('PAYSTACK_SECRET_KEY');
  if (!key) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  return key;
}

async function paystackPost(path: string, body: unknown) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function sendMerchantWelcomeEmail(args: { email: string; businessName: string; tagCode: string }) {
  await sendEmail(
    "You're live on RedFace Pay",
    `<h2>Welcome aboard, ${args.businessName}!</h2>
     <p>Your RedFace Pay account is <b>approved</b> and payouts are active. Settlements
     go straight to your verified bank account via Paystack — RedFace Pay never holds your money.</p>
     <ul>
       <li><b>Your NFC tag code:</b> ${args.tagCode}</li>
       <li><b>Sign in to your portal:</b> <a href="${APP_URL}">${APP_URL}</a></li>
     </ul>
     <p>Share your payment link, generate QR codes, and track every sale from your merchant portal.</p>`,
    args.email,
  );
}

function autoApproveDeps() {
  return {
    platformFeePercent: PLATFORM_FEE_PERCENT,
    appUrl: APP_URL,
    sendWelcomeEmail: sendMerchantWelcomeEmail,
  };
}

/** Route checkout initialization through the payment provider spine (Paystack today, Stripe later). */
async function initializeCheckout(payload: Record<string, unknown>) {
  if (activeProviderName() === 'paystack') {
    const r = await initializePaystackCheckoutFull(secret(), payload);
    return {
      status: r.ok,
      message: r.message,
      data: {
        authorization_url: r.authorization_url,
        access_code: r.access_code,
        reference: r.reference,
      },
    };
  }
  const provider = getPaymentProvider();
  const meta = (payload.metadata ?? {}) as Record<string, unknown>;
  const r = await provider.initializeCheckout({
    email: String(payload.email),
    amountSubunits: Number(payload.amount),
    currency: String(payload.currency),
    reference: String(payload.reference),
    callbackUrl: String(payload.callback_url ?? APP_URL),
    metadata: meta,
    subaccount: payload.subaccount ? String(payload.subaccount) : null,
  });
  return {
    status: r.ok,
    message: r.message,
    data: {
      authorization_url: r.authorization_url,
      access_code: r.access_code,
      reference: r.reference,
    },
  };
}

// Amounts arrive in major units (e.g. ZAR 10.50). Paystack works in subunits.
function toSubunits(major: number): number {
  return Math.round(Number(major) * 100);
}

interface Pricing {
  plan: MerchantPlan;
  percent: number;
  cap: number | null;
  feeSub: number;
}

function planLabel(plan: MerchantPlan): string {
  switch (plan) {
    case 'founding': return 'Worry-Free Founding Member';
    case 'marketplace': return 'Marketplace Plan';
    case 'premium': return 'Premium Plan';
    default: return 'Small Merchant Plan';
  }
}

function computePricing(input: {
  amountSub: number;
  plan?: string | null;
  customPercent?: number | null;
  capMajor?: number | null;
}): Pricing {
  const allowed = ['small', 'marketplace', 'premium', 'founding'];
  const plan = (allowed.includes(String(input.plan)) ? input.plan : 'small') as MerchantPlan;
  const fallbackPercent = defaultPlanPercent(plan);
  const percent = Number.isFinite(Number(input.customPercent))
    ? Math.max(0, Math.min(10, Number(input.customPercent)))
    : fallbackPercent;
  const capSub = Number.isFinite(Number(input.capMajor)) && Number(input.capMajor) >= 0
    ? toSubunits(Number(input.capMajor))
    : null;
  const rawFeeSub = Math.max(0, Math.round(input.amountSub * (percent / 100)));
  return {
    plan,
    percent,
    cap: capSub === null ? null : capSub / 100,
    feeSub: capSub === null ? rawFeeSub : Math.min(rawFeeSub, capSub),
  };
}

async function getOrCreateProductPlan(product: Record<string, unknown>, currency: string): Promise<string> {
  const existing = String(product.paystack_plan_code ?? '').trim();
  if (existing) return existing;

  const interval = String(product.subscription_interval ?? 'monthly');
  const ps = await paystackPost('/plan', {
    name: String(product.name ?? 'Subscription').slice(0, 48),
    interval,
    amount: toSubunits(Number(product.price)),
    currency,
  });
  if (!ps?.status || !ps.data?.plan_code) {
    throw new Error(ps?.message || 'Could not create Paystack plan for this product');
  }
  const planCode = ps.data.plan_code as string;
  await admin.from('products').update({ paystack_plan_code: planCode }).eq('id', product.id);
  return planCode;
}

function applyMerchantRouting(
  payload: Record<string, unknown>,
  merchant: Record<string, unknown>,
  feeSub: number,
  amountSub: number,
  currency = 'ZAR',
) {
  const routeCode = String(merchant.paystack_subaccount || '').trim();
  if (routeCode.startsWith('SPL_')) {
    payload.split_code = routeCode;
    return;
  }
  if (!routeCode) return;

  // ZA card fees are typically ~2.9% + R1. Micropayments (e.g. R1) leave a
  // negative merchant share once Paystack fees are taken from the subaccount.
  const cur = currency.toUpperCase();
  const estProcessorFee =
    cur === 'ZAR' ? Math.ceil(amountSub * 0.029) + 100 : Math.ceil(amountSub * 0.039);
  const maxPlatformCharge = Math.max(0, amountSub - estProcessorFee - 1);
  const safeFeeSub = Math.min(Math.max(0, feeSub), maxPlatformCharge);

  if (maxPlatformCharge <= 0) {
    // Caller should reject before initialize — keep routing off so Paystack
    // does not return "Merchant share cannot be lower than zero".
    return;
  }

  payload.subaccount = routeCode;
  // Main account bears processor fees so tiny settlements still clear.
  payload.bearer = 'account';
  if (safeFeeSub > 0) payload.transaction_charge = safeFeeSub;
}

function friendlyPaystackInitError(message: string | undefined, currency: string): { message: string; status: number } {
  const msg = (message || '').trim() || 'Could not start payment';
  if (/merchant share|lower than zero/i.test(msg)) {
    return { message: minCardAmountMessage(currency), status: 400 };
  }
  return { message: msg, status: 502 };
}

function ecosystemMetadata(body: Record<string, unknown>): Record<string, unknown> {
  const rawApp = String(body.ecosystem_app ?? body.ecosystem_from ?? '').trim().toLowerCase();
  const aliases: Record<string, string> = {
    rflaundry: 'laundry',
    'redface-services': 'services',
    redfacetours: 'tours',
    'redface-tours': 'tours',
    handinhand: 'handinhand',
    'redface-agency': 'agency',
    redfaceagency: 'agency',
    redfacestudio: 'studio',
    'redface-studio': 'studio',
    takasit: 'takasit',
    pangolin: 'pangolin',
    pangolinclothing: 'pangolin',
    'off-menu': 'off-menu',
    offmenu: 'off-menu',
    tick3t: 'tick3t',
  };
  const app = aliases[rawApp] ?? rawApp;
  const bookingId = String(body.ecosystem_booking_id ?? body.commerce_order_id ?? '').trim();
  const bookingRef = String(body.booking_reference ?? '').trim();
  const commerceOrderId = String(body.commerce_order_id ?? '').trim();
  const commerceMerchantId = String(body.commerce_merchant_id ?? '').trim();
  if (!app && !bookingId && !commerceOrderId) return {};
  return {
    ecosystem_app: app || null,
    ecosystem_from: app || null,
    ecosystem_booking_id: bookingId || null,
    booking_reference: bookingRef || null,
    commerce_order_id: commerceOrderId || null,
    commerce_merchant_id: commerceMerchantId || null,
  };
}

function bodyMetadataObject(body: Record<string, unknown>): Record<string, unknown> {
  if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) return {};
  return { ...(body.metadata as Record<string, unknown>) };
}

/** Tick3t tickets are not catalog products — never run resolveCartItems on them. */
function isTick3tCheckout(body: Record<string, unknown>): boolean {
  const eco = ecosystemMetadata(body);
  const meta = bodyMetadataObject(body);
  const app = String(eco.ecosystem_app ?? body.ecosystem_from ?? '').toLowerCase();
  return app === 'tick3t'
    || String(meta.feature ?? '').toLowerCase() === 'tick3t'
    || String(meta.source ?? '').toLowerCase() === 'tick3t'
    || String(meta.ecosystem_from ?? '').toLowerCase() === 'tick3t';
}

/** Metadata persisted on the transaction + Paystack for ticket issuance. */
function tick3tCheckoutMetadata(
  body: Record<string, unknown>,
  cartItemsInput: unknown,
): Record<string, unknown> {
  const meta = {
    ...bodyMetadataObject(body),
    ...ecosystemMetadata(body),
    feature: 'tick3t',
    source: String(bodyMetadataObject(body).source ?? 'tick3t'),
  };
  const cart = Array.isArray(cartItemsInput) && cartItemsInput.length
    ? cartItemsInput
    : Array.isArray(meta.cart_items) && meta.cart_items.length
      ? meta.cart_items
      : null;
  if (cart) {
    meta.cart_items = cart;
    meta.cart_items_json = typeof meta.cart_items_json === 'string' && meta.cart_items_json
      ? meta.cart_items_json
      : JSON.stringify(cart);
    if (meta.quantity == null) {
      meta.quantity = (cart as Record<string, unknown>[]).reduce(
        (sum, row) => sum + Math.max(1, Number(row.quantity ?? row.qty) || 1),
        0,
      );
    }
  }
  return meta;
}

type Tick3tPriceResult =
  | { ok: true; amount: number; meta: Record<string, unknown> }
  | { ok: false; message: string };

/** Reprice Tick3t carts from ticket types + optional promo (never trust client amount). */
async function priceTick3tCheckout(
  // deno-lint-ignore no-explicit-any
  db: any,
  merchantId: string,
  metaIn: Record<string, unknown>,
): Promise<Tick3tPriceResult> {
  const meta: Record<string, unknown> = { ...metaIn };
  let cart = Array.isArray(meta.cart_items) ? (meta.cart_items as Record<string, unknown>[]) : [];
  if (!cart.length && meta.ticket_type_id) {
    cart = [{
      ticket_type_id: meta.ticket_type_id,
      event_id: meta.event_id,
      quantity: Math.max(1, Number(meta.quantity) || 1),
      type: 'ticket',
    }];
  }
  if (!cart.length) {
    return { ok: false, message: 'Tick3t cart is empty' };
  }

  let subtotal = 0;
  let eventId: string | null = meta.event_id ? String(meta.event_id) : null;
  const pricedCart: Record<string, unknown>[] = [];
  const now = Date.now();

  for (const line of cart) {
    const typeId = String(line.ticket_type_id ?? '').trim();
    const qty = Math.max(1, Math.floor(Number(line.quantity ?? line.qty) || 1));
    if (!typeId) return { ok: false, message: 'cart item missing ticket_type_id' };

    const { data: tt, error } = await db
      .from('tick3t_ticket_types')
      .select('id, merchant_id, event_id, name, price_zar, status, capacity, sold_count, sale_opens_at, sale_closes_at, max_per_customer')
      .eq('id', typeId)
      .eq('merchant_id', merchantId)
      .maybeSingle();
    if (error || !tt) return { ok: false, message: 'Invalid ticket type' };
    if (String(tt.status) === 'sold_out' || String(tt.status) === 'hidden' || String(tt.status) === 'draft') {
      return { ok: false, message: 'Ticket type is not on sale' };
    }
    if (tt.sale_opens_at && new Date(tt.sale_opens_at).getTime() > now) {
      return { ok: false, message: 'Ticket sales have not opened' };
    }
    if (tt.sale_closes_at && new Date(tt.sale_closes_at).getTime() < now) {
      return { ok: false, message: 'Ticket sales have closed' };
    }
    if (tt.max_per_customer != null && qty > Number(tt.max_per_customer)) {
      return { ok: false, message: `Max ${tt.max_per_customer} per customer` };
    }
    if (tt.capacity != null) {
      const remaining = Number(tt.capacity) - Number(tt.sold_count ?? 0);
      if (qty > remaining) return { ok: false, message: `Only ${Math.max(0, remaining)} tickets left` };
    }

    const unit = Number(tt.price_zar) || 0;
    subtotal += unit * qty;
    eventId = eventId || String(tt.event_id);
    pricedCart.push({
      ...line,
      ticket_type_id: tt.id,
      event_id: tt.event_id,
      name: tt.name,
      price: unit,
      quantity: qty,
      type: 'ticket',
      product_type: 'ticket',
    });
  }

  subtotal = Math.round(subtotal * 100) / 100;
  let discount = 0;
  const promoCode = String(meta.promo_code ?? '').trim().toUpperCase();
  if (promoCode) {
    const { data: promo, error: promoErr } = await db.rpc('tick3t_promo_validate', {
      p_merchant_id: merchantId,
      p_code: promoCode,
      p_event_id: eventId,
      p_subtotal: subtotal,
    });
    if (promoErr || !promo?.ok) {
      return { ok: false, message: String(promo?.message || promoErr?.message || 'Invalid promo code') };
    }
    discount = Math.max(0, Number(promo.discount_zar) || 0);
    meta.promo_id = promo.promo_id;
    meta.promo_code = promo.code || promoCode;
    meta.discount_type = promo.discount_type;
    meta.discount_value = promo.discount_value;
  }

  const amount = Math.round(Math.max(subtotal - discount, 0) * 100) / 100;
  if (amount <= 0) {
    return { ok: false, message: 'Amount after discount must be greater than zero' };
  }

  meta.cart_items = pricedCart;
  meta.cart_items_json = JSON.stringify(pricedCart);
  meta.quantity = pricedCart.reduce(
    (sum, row) => sum + Math.max(1, Number(row.quantity) || 1),
    0,
  );
  if (eventId) meta.event_id = eventId;
  meta.subtotal_zar = subtotal;
  meta.discount_zar = discount;
  meta.amount_zar = amount;

  return { ok: true, amount, meta };
}

async function checkoutIdempotentResponse(identity: CheckoutIdentity): Promise<Response | null> {
  if (identity.alreadyPaid) {
    return json({
      status: true,
      already_paid: true,
      reference: identity.reference,
      message: 'Payment already received.',
      idempotent: true,
      retry_count: identity.retryCount,
    });
  }
  if (identity.reused && identity.cachedResponse?.authorization_url) {
    return json({
      status: true,
      idempotent: true,
      retry_count: identity.retryCount,
      message: 'Payment already started.',
      ...identity.cachedResponse,
    });
  }
  return null;
}

async function persistCheckoutResponse(
  merchantId: string,
  idempotencyKey: string,
  reference: string,
  paymentSessionId: string | null,
  payload: Record<string, unknown>,
) {
  await completePaymentRequest(admin, {
    merchantId,
    idempotencyKey,
    requestType: 'checkout',
    status: 'completed',
    transactionReference: reference,
    paymentSessionId,
    responsePayload: payload,
  });
}

async function logPaymentCreated(
  body: Record<string, unknown>,
  merchantId: string,
  reference: string,
  idempotencyKey: string,
  amount: number,
  currency: string,
) {
  const eco = ecosystemMetadata(body);
  const app = String(eco.ecosystem_app ?? 'pay');
  await appendPlatformPaymentEvent(admin, {
    eventType: 'payment.created',
    reference,
    idempotencyKey,
    app: app && app !== 'null' ? app : 'pay',
    merchantId,
    amount,
    currency,
    payload: { source: 'init_payment' },
  });
}

// Begin a real Paystack checkout. We compute the platform fee, persist a pending
// transaction keyed by our own reference, then hand Paystack that reference +
// the merchant's subaccount with a flat transaction_charge (the platform fee).
// The paystack-webhook is the authoritative confirmation; this just starts it.
async function createPaymentSession(body: Record<string, unknown>, req: Request) {
  const requestedMerchantId = String(body.merchant_id ?? '').trim();
  const resolved = await resolveActingMerchant(req, requestedMerchantId || undefined);
  if (!resolved.who) {
    return json({ status: false, message: resolved.error || 'Sign in as an approved merchant.' }, resolved.status ?? 401);
  }
  const who = resolved.who;

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const { data: authUser } = token ? await admin.auth.getUser(token) : { data: null };

  const idempotencyKey = ensureIdempotencyKey(readIdempotencyKey(req, body));
  const rawMeta = typeof body.metadata === 'object' && body.metadata
    ? { ...(body.metadata as Record<string, unknown>) }
    : {};
  // Stamp operator identity so Commerce Intelligence can answer "who sold this"
  // even when the merchant has not set up workspace operators yet.
  if (!rawMeta.operator_email && authUser?.user?.email) {
    rawMeta.operator_email = String(authUser.user.email).toLowerCase();
  }
  if (!rawMeta.operator_id && body.operator_id) {
    rawMeta.operator_id = String(body.operator_id).trim();
  }
  if (!rawMeta.operator_label && body.operator_label) {
    rawMeta.operator_label = String(body.operator_label).trim();
  }
  if (!rawMeta.correlation_id) {
    rawMeta.correlation_id = `corr_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  if (body.notes != null && String(body.notes).trim() && !rawMeta.notes) {
    rawMeta.notes = String(body.notes).trim().slice(0, 500);
  }
  if (body.customer_name != null && String(body.customer_name).trim() && !rawMeta.customer_name) {
    rawMeta.customer_name = String(body.customer_name).trim().slice(0, 120);
  }
  if (Array.isArray(body.tags) && body.tags.length && !rawMeta.tags) {
    rawMeta.tags = (body.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  }
  if (body.event_id != null && String(body.event_id).trim() && !rawMeta.event_id) {
    rawMeta.event_id = String(body.event_id).trim();
  }
  if (body.event_label != null && String(body.event_label).trim() && !rawMeta.event_label) {
    rawMeta.event_label = String(body.event_label).trim().slice(0, 120);
  }

  const result = await createPaymentSessionRecord(admin, {
    merchantId: who.merchant.id,
    amount: Number(body.amount ?? 0),
    currency: String(body.currency ?? 'ZAR'),
    label: String(body.label ?? '').trim() || null,
    paymentObjectId: String(body.payment_object_id ?? '').trim() || null,
    ttlSeconds: Number(body.ttl_seconds ?? 900),
    cartItems: body.cart_items,
    createdBy: authUser?.user?.id ?? null,
    idempotencyKey,
    metadata: rawMeta,
    businessIntent: String(body.business_intent ?? '').trim() || null,
    captureMethod: String(body.capture_method ?? '').trim() || null,
  });

  if (!result.ok) {
    return json({ status: false, message: result.error }, result.status ?? 400);
  }

  return json({
    status: true,
    session: result.session,
    message: result.message ?? (result.idempotent ? 'Payment already started. Waiting for customer…' : 'Ready for payment'),
    idempotent: result.idempotent ?? false,
    retry_count: result.retryCount ?? 0,
  }, result.idempotent ? 200 : 201);
}

async function getMerchantCapabilities(req: Request) {
  const who = await requireMerchant(req);
  if (!who) return json({ status: false, message: 'Sign in as an approved merchant.' }, 401);

  const caps = await resolveMerchantCapabilities(admin, who.merchant.id);
  if (!caps.ok) return json({ status: false, message: caps.error }, 404);

  return json({ status: true, capabilities: caps.data.flags, data: caps.data });
}

function buildSessionPayUrl(merchantId: string, session: Record<string, unknown>): string {
  const token = String(session.public_token ?? '');
  const objId = String(session.payment_object_id ?? '').trim();
  const params = new URLSearchParams({ session: token });
  if (objId) params.set('obj', objId);
  return `${APP_URL}/pay/${merchantId}?${params.toString()}`;
}

async function sendPaymentRequest(body: Record<string, unknown>, req: Request) {
  const who = await requireMerchant(req);
  if (!who) return json({ status: false, message: 'Sign in as an approved merchant.' }, 401);

  const email = String(body.customer_email ?? '').trim().toLowerCase();
  const phone = String(body.customer_phone ?? '').trim();
  const sendEmail = body.send_email !== false && !!email;
  const sendWhatsapp = body.send_whatsapp !== false && !!phone;

  if (!sendEmail && !sendWhatsapp) {
    return json({ status: false, message: 'customer_email or customer_phone is required.' }, 400);
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const { data: authUser } = token ? await admin.auth.getUser(token) : { data: null };
  const idempotencyKey = ensureIdempotencyKey(readIdempotencyKey(req, body));

  const result = await createPaymentSessionRecord(admin, {
    merchantId: who.merchant.id,
    amount: Number(body.amount ?? 0),
    currency: String(body.currency ?? 'ZAR'),
    label: String(body.label ?? '').trim() || null,
    paymentObjectId: String(body.payment_object_id ?? '').trim() || null,
    ttlSeconds: Number(body.ttl_seconds ?? 86400),
    createdBy: authUser?.user?.id ?? null,
    idempotencyKey,
    requestType: 'payment_session',
    businessIntent: 'collect_payment',
    captureMethod: 'payment_link',
  });

  if (!result.ok) {
    return json({ status: false, message: result.error }, result.status ?? 400);
  }

  const session = result.session as Record<string, unknown>;
  const sessionId = String(session.id ?? '');
  const payUrl = buildSessionPayUrl(who.merchant.id, session);
  const amount = Number(session.amount ?? 0);
  const currency = String(session.currency ?? 'ZAR');
  const label = String(session.label ?? '').trim();
  const businessName = String(who.merchant.business_name ?? 'A merchant');
  const channels: string[] = [];

  const amountLabel = `${currency} ${amount.toFixed(2)}`;
  const noteLine = label ? `\nFor: ${label}` : '';

  if (sendEmail) {
    await admin.rpc('enqueue_platform_notification', {
      p_channel: 'email',
      p_recipient: email,
      p_event_type: 'payment_request',
      p_body: `${businessName} sent you a payment request for ${amountLabel}.${noteLine}\n\nPay securely here:\n${payUrl}\n\nThis link expires when the request is paid or cancelled.`,
      p_payload: { session_id: sessionId, amount, currency, label, pay_url: payUrl },
      p_subject: `Payment request — ${amountLabel}`,
      p_merchant_id: who.merchant.id,
      p_reference: sessionId,
    }).then(() => {}, () => {});
    channels.push('email');
  }

  if (sendWhatsapp) {
    const waBody = `${businessName} requests ${amountLabel}${label ? ` (${label})` : ''}. Pay: ${payUrl}`;
    await admin.rpc('enqueue_platform_notification', {
      p_channel: 'whatsapp',
      p_recipient: phone,
      p_event_type: 'payment_request',
      p_body: waBody,
      p_payload: { session_id: sessionId, amount, currency, label, pay_url: payUrl },
      p_subject: 'Payment request',
      p_merchant_id: who.merchant.id,
      p_reference: sessionId,
    }).then(() => {}, () => {});
    channels.push('whatsapp');
  }

  await admin.from('payment_sessions').update({
    customer_email: sendEmail ? email : null,
    customer_phone: sendWhatsapp ? phone : null,
    request_sent_at: new Date().toISOString(),
    request_channels: channels,
  }).eq('id', sessionId).eq('merchant_id', who.merchant.id);

  await admin.from('merchant_notifications').insert({
    merchant_id: who.merchant.id,
    type: 'payment_request_sent',
    title: 'Payment request sent',
    body: `Sent ${amountLabel} to ${sendEmail ? email : phone}.`,
    reference: sessionId,
    meta: { channels, pay_url: payUrl },
  }).then(() => {}, () => {});

  return json({
    status: true,
    session: result.session,
    pay_url: payUrl,
    channels,
    message: `Payment request sent via ${channels.join(' and ')}.`,
    idempotent: result.idempotent ?? false,
  }, result.idempotent ? 200 : 201);
}

async function chargeSavedCard(body: Record<string, unknown>, req: Request) {
  const merchantId = String(body.merchant_id ?? '');
  const email = String(body.email ?? '').trim().toLowerCase();
  const savedCardId = String(body.saved_card_id ?? '');
  const buyerAuthorised = body.buyer_authorised === true;

  if (!merchantId || !email || !savedCardId) {
    return json({ status: false, message: 'merchant_id, email, and saved_card_id are required' }, 400);
  }
  if (!buyerAuthorised) {
    return json({ status: false, message: 'Buyer authorisation is required' }, 400);
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token) {
    const { data: authUser } = await admin.auth.getUser(token);
    const authEmail = authUser?.user?.email?.toLowerCase();
    if (authEmail && authEmail !== email) {
      return json({ status: false, message: 'Sign in with the same email as this checkout.' }, 403);
    }
  }

  const { data: savedCard } = await admin
    .from('buyer_payment_authorizations')
    .select('id, authorization_code, buyer_email, last4, brand')
    .eq('id', savedCardId)
    .eq('buyer_email', email)
    .eq('reusable', true)
    .maybeSingle();

  if (!savedCard?.authorization_code) {
    return json({ status: false, message: 'Saved card not found.' }, 404);
  }

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, business_name, status, paystack_subaccount, merchant_plan, subscription_status, platform_fee_percent, platform_fee_cap')
    .eq('id', merchantId)
    .maybeSingle();

  if (!merchant || merchant.status !== 'approved') {
    return json({ status: false, message: 'Merchant not found or not approved' }, 400);
  }

  const currency = String(body.currency ?? 'ZAR');
  const amount = Number(body.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ status: false, message: 'amount must be greater than zero' }, 400);
  }

  const identity = await resolveCheckoutIdentity(admin, req, body, merchantId);
  const { reference, idempotencyKey } = identity;

  const amountSub = toSubunits(amount);
  const pricing = computePricing({
    amountSub,
    plan: feePlanFromMerchant(merchant),
    customPercent: merchant.platform_fee_percent,
    capMajor: merchant.platform_fee_cap,
  });
  const feeSub = pricing.feeSub;
  const platformFee = feeSub / 100;
  const paymentObjectId = String(body.payment_object_id ?? '').trim() || null;
  const sessionTokenInput = String(body.payment_session_token ?? '').trim() || null;

  const { error: txErr } = await admin.from('transactions').insert({
    merchant_id: merchantId,
    reference,
    amount,
    card_amount: amount,
    platform_fee: platformFee,
    platform_fee_plan: pricing.plan,
    platform_fee_percent: pricing.percent,
    platform_fee_cap: pricing.cap,
    currency,
    status: 'pending',
    payment_object_id: paymentObjectId,
    buyer_email: email,
    buyer_authorised: true,
    buyer_authorised_at: new Date().toISOString(),
  });
  if (txErr) {
    return json({ status: false, message: txErr.message || 'Could not record payment' }, 500);
  }

  const metadata: Record<string, unknown> = {
    merchant_id: merchantId,
    payment_object_id: paymentObjectId,
    buyer_email: email,
    saved_card_id: savedCardId,
    idempotency_key: idempotencyKey,
    platform_fee: platformFee,
    payment_session_token: sessionTokenInput || null,
    ...ecosystemMetadata(body),
  };

  const routeCode = String(merchant.paystack_subaccount || '').trim();
  const chargeInput = {
    email,
    amountMajor: amount,
    authorizationCode: savedCard.authorization_code,
    reference,
    currency,
    metadata,
    ...(routeCode.startsWith('SPL_')
      ? { splitCode: routeCode }
      : routeCode
        ? { subaccount: routeCode, transactionCharge: feeSub > 0 ? feeSub : undefined }
        : {}),
  };

  const ps = await chargePaystackAuthorization(secret(), chargeInput);
  if (!ps.ok) {
    await admin.from('transactions').update({ status: 'failed' }).eq('reference', reference);
    return json({ status: false, message: ps.message ?? 'Card charge failed', reference }, 400);
  }

  const chargeStatus = String((ps.data as { status?: string })?.status ?? '');
  await admin.from('buyer_payment_authorizations').update({
    last_used_at: new Date().toISOString(),
  }).eq('id', savedCardId);

  if (chargeStatus === 'success') {
    await markSessionPaid(admin, reference, null);
  }

  return json({
    status: true,
    reference,
    charge_status: chargeStatus || 'pending',
    platform_fee: platformFee,
    message: chargeStatus === 'success' ? 'Payment successful' : 'Charge submitted — confirming…',
  });
}

async function chargeCard(body: Record<string, unknown>, req: Request) {
  const merchantId = String(body.merchant_id ?? '');
  const email = String(body.email ?? '').trim().toLowerCase();
  const buyerAuthorised = body.buyer_authorised === true;
  const cardNumber = String(body.card_number ?? '').replace(/\D/g, '');
  const cvv = String(body.cvv ?? '').replace(/\D/g, '');
  const expiryMonth = String(body.expiry_month ?? '').replace(/\D/g, '');
  const expiryYear = String(body.expiry_year ?? '').replace(/\D/g, '');

  if (!merchantId || !email || !cardNumber || !cvv || !expiryMonth || !expiryYear) {
    return json({ status: false, message: 'merchant_id, email, card details, and expiry are required' }, 400);
  }
  if (!buyerAuthorised) {
    return json({ status: false, message: 'Buyer authorisation is required' }, 400);
  }
  if (cardNumber.length < 13 || cardNumber.length > 19) {
    return json({ status: false, message: 'Invalid card number' }, 400);
  }
  if (cvv.length < 3 || cvv.length > 4) {
    return json({ status: false, message: 'Invalid CVV' }, 400);
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token) {
    const { data: authUser } = await admin.auth.getUser(token);
    const authEmail = authUser?.user?.email?.toLowerCase();
    if (authEmail && authEmail !== email) {
      return json({ status: false, message: 'Sign in with the same email as this checkout.' }, 403);
    }
  }

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, business_name, status, paystack_subaccount, paystack_split_code, merchant_plan, subscription_status, platform_fee_percent, platform_fee_cap')
    .eq('id', merchantId)
    .maybeSingle();

  if (!merchant || merchant.status !== 'approved') {
    return json({ status: false, message: 'Merchant not found or not approved' }, 400);
  }

  const currency = String(body.currency ?? 'ZAR');
  const amount = Number(body.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ status: false, message: 'amount must be greater than zero' }, 400);
  }

  const identity = await resolveCheckoutIdentity(admin, req, body, merchantId);
  const { reference, idempotencyKey } = identity;

  const amountSub = toSubunits(amount);
  const pricing = computePricing({
    amountSub,
    plan: feePlanFromMerchant(merchant),
    customPercent: merchant.platform_fee_percent,
    capMajor: merchant.platform_fee_cap,
  });
  const feeSub = pricing.feeSub;
  const platformFee = feeSub / 100;
  const paymentObjectId = String(body.payment_object_id ?? '').trim() || null;
  const sessionTokenInput = String(body.payment_session_token ?? '').trim() || null;

  let paymentSessionMeta: Record<string, unknown> = {};
  if (sessionTokenInput) {
    const { data: sess } = await admin
      .from('payment_sessions')
      .select('id, amount, metadata, status, expires_at')
      .eq('merchant_id', merchantId)
      .eq('public_token', sessionTokenInput)
      .in('status', ['waiting', 'opened', 'processing'])
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (sess?.metadata && typeof sess.metadata === 'object') {
      paymentSessionMeta = sess.metadata as Record<string, unknown>;
    }
  }

  const posSaleId = String(paymentSessionMeta.pos_sale_id ?? '').trim() || null;

  const { error: txErr } = await admin.from('transactions').insert({
    merchant_id: merchantId,
    reference,
    amount,
    card_amount: amount,
    platform_fee: platformFee,
    platform_fee_plan: pricing.plan,
    platform_fee_percent: pricing.percent,
    platform_fee_cap: pricing.cap,
    currency,
    status: 'pending',
    payment_object_id: paymentObjectId,
    buyer_email: email,
    buyer_authorised: true,
    buyer_authorised_at: new Date().toISOString(),
  });
  if (txErr) {
    return json({ status: false, message: txErr.message || 'Could not record payment' }, 500);
  }

  const metadata: Record<string, unknown> = {
    merchant_id: merchantId,
    payment_object_id: paymentObjectId,
    buyer_email: email,
    entry_method: 'manual_card',
    idempotency_key: idempotencyKey,
    platform_fee: platformFee,
    payment_session_token: sessionTokenInput || null,
    ...(posSaleId ? { pos_sale_id: posSaleId, split_tender: 'card' } : {}),
    ...ecosystemMetadata(body),
  };

  const routeCode = String(merchant.paystack_split_code || merchant.paystack_subaccount || '').trim();
  const ps = await chargePaystackCard(secret(), {
    email,
    amountMajor: amount,
    reference,
    currency,
    card: {
      number: cardNumber,
      cvv,
      expiry_month: expiryMonth,
      expiry_year: expiryYear,
    },
    metadata,
    ...(routeCode.startsWith('SPL_')
      ? { splitCode: routeCode }
      : routeCode
        ? { subaccount: routeCode, transactionCharge: feeSub > 0 ? feeSub : undefined }
        : {}),
  });

  if (!ps.ok) {
    await admin.from('transactions').update({ status: 'failed' }).eq('reference', reference);
    return json({ status: false, message: ps.message ?? 'Card charge failed', reference }, 400);
  }

  const psData = (ps.data ?? {}) as Record<string, unknown>;
  const chargeStatus = String(psData.status ?? '');
  const authUrl = typeof psData.url === 'string' ? psData.url : null;

  if (chargeStatus === 'success') {
    await admin.from('transactions').update({ status: 'success' }).eq('reference', reference);
    const { data: paidTxn } = await admin.from('transactions').select('id').eq('reference', reference).maybeSingle();
    await markSessionPaid(admin, reference, paidTxn?.id ?? null);
  }

  if (chargeStatus === 'open_url' && authUrl) {
    return json({
      status: true,
      reference,
      charge_status: chargeStatus,
      authorization_url: authUrl,
      platform_fee: platformFee,
      message: 'Complete verification to finish payment.',
    });
  }

  return json({
    status: true,
    reference,
    charge_status: chargeStatus || 'pending',
    platform_fee: platformFee,
    message: chargeStatus === 'success' ? 'Payment successful' : 'Charge submitted — confirming…',
  });
}

async function provisionDedicatedAccount(body: Record<string, unknown>, req: Request) {
  const auth = await requireMerchant(req);
  if (!auth) return json({ status: false, message: 'Sign in as an approved merchant.' }, 403);

  const merchantId = String(body.merchant_id ?? auth.merchant.id);
  if (merchantId !== auth.merchant.id && !(await requireAdmin(req))) {
    return json({ status: false, message: 'Not authorized for this merchant.' }, 403);
  }

  const { dvaEligibleCountry, splitMerchantContactName, upsertMerchantDedicatedAccount } = await import('../_shared/merchantDedicatedAccounts.ts');
  const eligible = dvaEligibleCountry(auth.merchant.country);
  if (!eligible) {
    return json({
      status: false,
      message: 'Dedicated bank accounts are available for Nigeria and Ghana merchants only.',
    }, 400);
  }

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, business_name, email, phone, country, paystack_subaccount, paystack_split_code, status')
    .eq('id', merchantId)
    .maybeSingle();

  if (!merchant || merchant.status !== 'approved') {
    return json({ status: false, message: 'Merchant not found or not approved.' }, 400);
  }

  const routeCode = String(merchant.paystack_split_code || merchant.paystack_subaccount || '').trim();
  if (!routeCode) {
    return json({ status: false, message: 'Paystack payout account is not set up yet. Complete merchant approval first.' }, 400);
  }

  const { data: existing } = await admin
    .from('merchant_dedicated_accounts')
    .select('id, status, account_number, account_name, bank_name, currency, is_active, error_message')
    .eq('merchant_id', merchantId)
    .maybeSingle();

  if (existing?.is_active && existing.account_number) {
    return json({ status: true, data: existing, message: 'Bank account already active.' });
  }
  if (existing?.status === 'pending' && !body.force) {
    return json({
      status: true,
      data: existing,
      message: 'Bank account provisioning is in progress. This usually takes a few minutes.',
    });
  }

  const { firstName, lastName } = splitMerchantContactName(String(merchant.business_name ?? 'Merchant'));
  const customerRes = await createOrFetchPaystackCustomer(secret(), {
    email: String(merchant.email),
    first_name: firstName,
    last_name: lastName,
    phone: merchant.phone ? String(merchant.phone) : null,
  });
  if (!customerRes.ok) {
    return json({ status: false, message: customerRes.message ?? 'Could not create Paystack customer.' }, 400);
  }

  const customer = (customerRes.data ?? {}) as Record<string, unknown>;
  const customerCode = String(customer.customer_code ?? '');
  if (!customerCode) {
    return json({ status: false, message: 'Paystack did not return a customer code.' }, 502);
  }

  const isTest = secret().startsWith('sk_test');
  const preferredBank = String(body.preferred_bank ?? '').trim() || (isTest ? 'test-bank' : '');
  const splitCode = String(merchant.paystack_split_code ?? '').trim();
  const subaccount = String(merchant.paystack_subaccount ?? '').trim();

  const dvaRes = await createPaystackDedicatedAccount(secret(), {
    customerCode,
    preferredBank: preferredBank || undefined,
    splitCode: splitCode.startsWith('SPL_') ? splitCode : undefined,
    subaccount: !splitCode.startsWith('SPL_') && subaccount.startsWith('ACCT_') ? subaccount : undefined,
  });

  if (!dvaRes.ok) {
    await admin.from('merchant_dedicated_accounts').upsert({
      merchant_id: merchantId,
      status: 'failed',
      country_code: eligible.code,
      currency: eligible.currency,
      paystack_customer_code: customerCode,
      is_active: false,
      error_message: dvaRes.message ?? 'Provisioning failed',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'merchant_id' });
    return json({ status: false, message: dvaRes.message ?? 'Could not create dedicated account.' }, 400);
  }

  const dvaData = (dvaRes.data ?? {}) as Record<string, unknown>;
  await upsertMerchantDedicatedAccount(admin, merchantId, {
    ...dvaData,
    customer: dvaData.customer ?? customer,
  });

  const { data: row } = await admin
    .from('merchant_dedicated_accounts')
    .select('id, status, account_number, account_name, bank_name, bank_slug, currency, country_code, is_active, error_message, created_at, updated_at')
    .eq('merchant_id', merchantId)
    .maybeSingle();

  return json({
    status: true,
    data: row,
    message: row?.is_active
      ? 'Your dedicated bank account is ready.'
      : 'Bank account provisioning started — we will notify you when it is active.',
  });
}

async function getDedicatedAccount(body: Record<string, unknown>, req: Request) {
  const auth = await requireMerchant(req);
  if (!auth) return json({ status: false, message: 'Sign in as an approved merchant.' }, 403);

  const merchantId = String(body.merchant_id ?? auth.merchant.id);
  if (merchantId !== auth.merchant.id && !(await requireAdmin(req))) {
    return json({ status: false, message: 'Not authorized for this merchant.' }, 403);
  }

  const { data: row } = await admin
    .from('merchant_dedicated_accounts')
    .select('id, status, account_number, account_name, bank_name, bank_slug, currency, country_code, is_active, error_message, created_at, updated_at')
    .eq('merchant_id', merchantId)
    .maybeSingle();

  const { dvaEligibleCountry } = await import('../_shared/merchantDedicatedAccounts.ts');
  return json({
    status: true,
    data: row,
    eligible: !!dvaEligibleCountry(auth.merchant.country),
  });
}

async function createCryptoPayment(body: Record<string, unknown>, req: Request) {
  const auth = await requireMerchant(req);
  if (!auth) return json({ status: false, message: 'Sign in as an approved merchant.' }, 403);

  const merchantId = String(body.merchant_id ?? auth.merchant.id);
  if (merchantId !== auth.merchant.id && !(await requireAdmin(req))) {
    return json({ status: false, message: 'Not authorized for this merchant.' }, 403);
  }

  const { createCryptoPaymentRequest } = await import('../_shared/merchantCrypto.ts');
  const asset = String(body.asset ?? 'usdt_trc20') as 'btc' | 'eth' | 'usdt_trc20' | 'usdt_erc20';
  const result = await createCryptoPaymentRequest(admin, {
    merchantId,
    fiatAmount: Number(body.amount),
    fiatCurrency: String(body.currency ?? 'ZAR'),
    asset,
    customerEmail: body.customer_email ? String(body.customer_email) : null,
    customerNote: body.customer_note ? String(body.customer_note) : null,
    paymentSessionId: body.payment_session_id ? String(body.payment_session_id) : null,
  });

  if (!result.ok) return json({ status: false, message: result.message }, 400);
  return json({ status: true, request: result.request });
}

async function createPublicCryptoPayment(body: Record<string, unknown>, req: Request) {
  const merchantId = String(body.merchant_id ?? '');
  const email = String(body.email ?? '').trim();
  const buyerAuthorised = body.buyer_authorised === true;
  const currency = String(body.currency ?? 'ZAR').toUpperCase();
  const productId = String(body.product_id ?? '').trim();
  const invoiceId = String(body.invoice_id ?? '').trim();
  const sessionTokenInput = String(body.payment_session_token ?? '').trim() || null;
  const sessionIdInput = String(body.payment_session_id ?? '').trim() || null;
  const hasSession = !!(sessionIdInput || sessionTokenInput);
  const storeCreditIdInput = String(body.store_credit_id ?? '').trim();

  if (!merchantId || !email.includes('@')) {
    return json({ status: false, message: 'merchant_id and a valid email are required' }, 400);
  }
  if (!buyerAuthorised) {
    return json({ status: false, message: 'Buyer authorisation is required before payment can start' }, 400);
  }
  if (storeCreditIdInput) {
    return json({ status: false, message: 'Crypto checkout cannot be combined with store credit in this flow.' }, 400);
  }
  if (hasSession && (productId || invoiceId)) {
    return json({ status: false, message: 'Payment sessions cannot be used with products or invoices' }, 400);
  }

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, business_name, status')
    .eq('id', merchantId)
    .maybeSingle();

  if (!merchant || merchant.status !== 'approved') {
    return json({ status: false, message: 'Merchant not found or not approved' }, 400);
  }

  let amount = Number(body.amount ?? 0);
  let paymentSessionId: string | null = null;
  let customerNote = String(body.label ?? body.customer_note ?? '').trim() || null;

  if (hasSession) {
    await admin.rpc('expire_payment_sessions').then(() => {}, () => {});
    let sq = admin
      .from('payment_sessions')
      .select('id, merchant_id, amount, currency, label, status, expires_at')
      .eq('merchant_id', merchantId)
      .in('status', ['waiting', 'opened', 'processing'])
      .gt('expires_at', new Date().toISOString());
    if (sessionIdInput) sq = sq.eq('id', sessionIdInput);
    else sq = sq.eq('public_token', sessionTokenInput!);
    const { data: sess } = await sq.maybeSingle();
    if (!sess) {
      return json({ status: false, message: 'Payment session not found or expired. Ask the merchant to press Ready again.' }, 400);
    }
    amount = Number(sess.amount);
    paymentSessionId = sess.id;
    customerNote = customerNote || (sess.label ? String(sess.label) : null);
  } else if (productId) {
    const { data: p } = await admin
      .from('products')
      .select('id, price, currency, name, billing_type')
      .eq('id', productId)
      .eq('merchant_id', merchantId)
      .maybeSingle();
    if (!p) return json({ status: false, message: 'Product not found' }, 404);
    if (p.billing_type === 'subscription') {
      return json({ status: false, message: 'Recurring subscriptions must be paid by card.' }, 400);
    }
    amount = Number(p.price ?? 0);
    customerNote = customerNote || String(p.name ?? '');
  } else if (invoiceId) {
    const invoicePaymentKind = String(body.payment_kind ?? body.pay_kind ?? 'full').toLowerCase() as InvoicePaymentKind;
    const checkout = await resolveInvoiceCheckout(admin, invoiceId, invoicePaymentKind);
    if (!checkout.ok) {
      return json({ status: false, message: checkout.error || 'Invoice not available for payment' }, 400);
    }
    amount = Number(checkout.amount ?? 0);
    customerNote = customerNote || `Invoice ${checkout.label ?? invoiceId}`;
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ status: false, message: 'amount is required' }, 400);
  }

  const { createCryptoPaymentRequest } = await import('../_shared/merchantCrypto.ts');
  const asset = String(body.asset ?? 'usdt_trc20') as 'btc' | 'eth' | 'usdt_trc20' | 'usdt_erc20';
  const result = await createCryptoPaymentRequest(admin, {
    merchantId,
    fiatAmount: amount,
    fiatCurrency: currency,
    asset,
    customerEmail: email,
    customerNote,
    paymentSessionId,
  });

  if (!result.ok) return json({ status: false, message: result.message }, 400);

  const reference = String((result.request as { reference?: string }).reference ?? '');
  const origin = req.headers.get('origin') || 'https://www.redfacepay.co.za';
  return json({
    status: true,
    request: result.request,
    checkout_url: reference ? `${origin}/crypto/${encodeURIComponent(reference)}` : null,
  });
}

async function cancelPaymentSession(body: Record<string, unknown>, req: Request) {
  const sessionId = String(body.session_id ?? '').trim();
  if (!sessionId) return json({ status: false, message: 'session_id is required' }, 400);

  // Load session first so platform / Entendre admins can cancel on the right merchant
  const { data: existing } = await admin
    .from('payment_sessions')
    .select('id, status, merchant_id')
    .eq('id', sessionId)
    .maybeSingle();

  if (!existing) return json({ status: false, message: 'Session not found' }, 404);

  const preferred =
    String(body.merchant_id ?? '').trim() || String(existing.merchant_id ?? '');
  const resolved = await resolveActingMerchant(req, preferred);
  if (!resolved.who) {
    return json({ status: false, message: resolved.error || 'Sign in as an approved merchant.' }, resolved.status ?? 401);
  }

  if (String(existing.merchant_id) !== resolved.who.merchant.id) {
    return json({ status: false, message: 'Session not found for this merchant.' }, 404);
  }

  if (!['waiting', 'opened', 'processing'].includes(existing.status)) {
    return json({ status: true, message: 'Session already closed' });
  }

  const reason = String(body.reason ?? body.void_reason ?? '').trim() || null;

  // Linked void event (never delete) — emits sale_voided on the activity stream
  const { data: voided, error: voidErr } = await admin.rpc('void_payment_session', {
    p_session_id: sessionId,
    p_reason: reason,
  });

  if (voidErr) {
    // Fallback if migration 0271 is not applied yet
    await admin.from('payment_sessions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', sessionId);
    return json({ status: true, message: 'Session cancelled' });
  }

  return json({
    status: true,
    message: 'Session voided',
    void: voided,
  });
}

async function getPaymentSession(body: Record<string, unknown>, req: Request) {
  const sessionId = String(body.session_id ?? '').trim();
  if (!sessionId) return json({ status: false, message: 'session_id is required' }, 400);

  await admin.rpc('expire_payment_sessions').then(() => {}, () => {});

  const { data: row } = await admin
    .from('payment_sessions')
    .select('id, public_token, amount, currency, label, status, expires_at, payment_object_id, opened_at, paid_at, created_at, merchant_id')
    .eq('id', sessionId)
    .maybeSingle();

  if (!row) return json({ status: false, message: 'Session not found' }, 404);

  const preferred =
    String(body.merchant_id ?? '').trim() || String(row.merchant_id ?? '');
  const resolved = await resolveActingMerchant(req, preferred);
  if (!resolved.who) {
    return json({ status: false, message: resolved.error || 'Sign in as an approved merchant.' }, resolved.status ?? 401);
  }
  if (String(row.merchant_id) !== resolved.who.merchant.id) {
    return json({ status: false, message: 'Session not found' }, 404);
  }

  const { merchant_id: _mid, ...session } = row;
  return json({ status: true, session });
}

/** Takasit / mobility — authorize fare at board (no capture yet). */
async function authorizePayment(body: Record<string, unknown>) {
  const merchantId = String(body.merchant_id ?? '').trim();
  const amount = Number(body.amount ?? 0);
  const currency = String(body.currency ?? 'ZAR');
  const label = String(body.label ?? '').trim();
  const meta = typeof body.metadata === 'object' && body.metadata
    ? (body.metadata as Record<string, unknown>)
    : {};
  const reservationId = String(meta.reservation_id ?? body.reservation_id ?? '').trim();
  const paymentMethod = String(body.payment_method ?? 'redface');
  const preauth = body.preauth === true || body.card_preauth === true || paymentMethod === 'card';
  const buyerEmail = String(body.email ?? body.buyer_email ?? meta.buyer_email ?? '').trim().toLowerCase();
  const authorizationCode = String(body.authorization_code ?? meta.authorization_code ?? '').trim();
  const recordOnly = body.record_only === true || paymentMethod === 'cash' || body.skip_paystack === true;

  if (!merchantId) {
    return json({ status: false, message: 'merchant_id is required' }, 400);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ status: false, message: 'amount must be greater than zero' }, 400);
  }

  if (preauth && !recordOnly) {
    if (currency.toUpperCase() !== 'ZAR') {
      return json({ status: false, message: 'Card preauthorization is ZAR-only via Paystack.' }, 400);
    }
    if (!buyerEmail && !authorizationCode) {
      return json({ status: false, message: 'email is required for card preauthorization.' }, 400);
    }

    const { data: merchant } = await admin
      .from('merchants')
      .select('id, business_name, status, paystack_subaccount, paystack_split_code, merchant_plan, subscription_status, platform_fee_percent, platform_fee_cap')
      .eq('id', merchantId)
      .maybeSingle();

    if (!merchant || merchant.status !== 'approved') {
      return json({ status: false, message: 'Merchant not found or not approved' }, 400);
    }

    const created = await createFareAuthorization(admin, {
      merchantId,
      amountZar: amount,
      currency,
      label: label || undefined,
      reservationId: reservationId || undefined,
      paymentMethod: 'card',
      buyerEmail: buyerEmail || undefined,
      status: 'pending_preauth',
      metadata: { ...meta, ...ecosystemMetadata(body) },
    });

    if (!created.ok) {
      return json({ status: false, message: created.message }, 400);
    }

    const row = created.row;
    const preauthRef = buildFarePreauthReference(row.id);
    await admin.from('fare_authorizations').update({
      paystack_preauth_reference: preauthRef,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id);

    const routeCode = String(merchant.paystack_split_code || merchant.paystack_subaccount || '').trim();
    const amountSub = toSubunits(amount);
    const pricing = computePricing({
      amountSub,
      plan: feePlanFromMerchant(merchant),
      customPercent: merchant.platform_fee_percent,
      capMajor: merchant.platform_fee_cap,
    });

    const preauthMeta = {
      merchant_id: merchantId,
      fare_authorization_id: row.id,
      reservation_id: reservationId || null,
      app: 'takasit',
      ecosystem_app: 'takasit',
      purchase_type: 'fare_preauth',
      ...ecosystemMetadata(body),
    };

    if (authorizationCode && buyerEmail) {
      const reserved = await reservePaystackPreauthorization(secret(), {
        email: buyerEmail,
        amountMajor: amount,
        authorizationCode,
        reference: preauthRef,
        currency,
      });
      if (!reserved.ok) {
        await admin.from('fare_authorizations').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', row.id);
        return json({ status: false, message: reserved.message ?? 'Card hold failed' }, 400);
      }
      const psData = (reserved.data ?? {}) as Record<string, unknown>;
      const auth = (psData.authorization ?? {}) as Record<string, unknown>;
      const { markFarePreauthReserved } = await import('../_shared/fareAuthorizations.ts');
      const updated = await markFarePreauthReserved(admin, String(psData.reference ?? preauthRef), {
        authorizationCode: String(auth.authorization_code ?? authorizationCode),
        buyerEmail,
        fareAuthorizationId: row.id,
      });
      return json({
        status: true,
        authorization_id: row.id,
        reference: String(psData.reference ?? preauthRef),
        amount,
        preauth_status: 'authorized',
        message: 'Card hold placed — capture when ride completes.',
        data: updated,
      });
    }

    const callbackUrl = String(body.callback_url ?? '').trim()
      || `${APP_URL}/ecosystem/checkout?app=takasit&fare_auth=${row.id}`;
    const splitCode = String(merchant.paystack_split_code ?? '').trim();
    const subaccount = String(merchant.paystack_subaccount ?? '').trim();
    const initialized = await initializePaystackPreauthorization(secret(), {
      email: buyerEmail,
      amountMajor: amount,
      reference: preauthRef,
      currency,
      callbackUrl,
      metadata: preauthMeta,
      splitCode: splitCode.startsWith('SPL_') ? splitCode : undefined,
      subaccount: !splitCode.startsWith('SPL_') && subaccount.startsWith('ACCT_') ? subaccount : undefined,
      transactionCharge: pricing.feeSub > 0 ? pricing.feeSub : undefined,
      expireAfterDays: Number(body.expire_after_days ?? 7),
      expireAction: 'release',
    });

    if (!initialized.ok) {
      await admin.from('fare_authorizations').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', row.id);
      return json({ status: false, message: initialized.message ?? 'Preauthorization failed' }, 400);
    }

    const initData = (initialized.data ?? {}) as Record<string, unknown>;
    await appendPlatformPaymentEvent(admin, {
      eventType: 'fare.preauth_initiated',
      reference: preauthRef,
      idempotencyKey: String(body.idempotency_key ?? '').trim() || null,
      app: 'takasit',
      merchantId,
      amount,
      currency,
      payload: { reservation_id: reservationId, authorization_id: row.id },
    });

    return json({
      status: true,
      authorization_id: row.id,
      reference: String(initData.reference ?? preauthRef),
      authorization_url: initData.authorization_url ?? null,
      access_code: initData.access_code ?? null,
      amount,
      preauth_status: 'pending_preauth',
      message: 'Redirect rider to authorization_url to place card hold.',
    });
  }

  const created = await createFareAuthorization(admin, {
    merchantId,
    amountZar: amount,
    currency,
    label: label || undefined,
    reservationId: reservationId || undefined,
    paymentMethod: recordOnly ? 'cash' : paymentMethod,
    buyerEmail: buyerEmail || undefined,
    metadata: { ...meta, ...ecosystemMetadata(body) },
  });

  if (!created.ok) {
    return json({ status: false, message: created.message }, 400);
  }

  const row = created.row;
  await appendPlatformPaymentEvent(admin, {
    eventType: 'fare.authorized',
    reference: `takasit-auth-${row.id}`,
    idempotencyKey: String(body.idempotency_key ?? '').trim() || null,
    app: 'takasit',
    merchantId,
    amount,
    currency,
    payload: { reservation_id: reservationId, authorization_id: row.id },
  });

  return json({
    status: true,
    authorization_id: row.id,
    reference: `takasit-auth-${row.id}`,
    amount: Number(row.amount_zar),
    message: 'Fare authorized — capture when ride completes.',
  });
}

/** Takasit / mobility — capture authorized fare at trip end. */
async function capturePayment(body: Record<string, unknown>) {
  const authorizationId = String(body.authorization_id ?? '').trim();
  const merchantId = String(body.merchant_id ?? '').trim() || undefined;
  const amount = body.amount != null ? Number(body.amount) : undefined;
  const recordOnly = body.record_only === true || body.skip_paystack === true;

  if (!authorizationId) {
    return json({ status: false, message: 'authorization_id is required' }, 400);
  }

  let platformFee = 0;
  if (!recordOnly) {
    const { data: authRow } = await admin
      .from('fare_authorizations')
      .select('merchant_id, amount_zar, currency')
      .eq('id', authorizationId)
      .maybeSingle();
    if (authRow) {
      const { data: merchant } = await admin
        .from('merchants')
        .select('merchant_plan, subscription_status, platform_fee_percent, platform_fee_cap')
        .eq('id', authRow.merchant_id)
        .maybeSingle();
      const captureAmount = amount ?? Number(authRow.amount_zar);
      const pricing = computePricing({
        amountSub: toSubunits(captureAmount),
        plan: merchant ? feePlanFromMerchant(merchant) : 'small',
        customPercent: merchant?.platform_fee_percent,
        capMajor: merchant?.platform_fee_cap,
      });
      platformFee = pricing.feeSub / 100;
    }
  }

  const captured = await captureFareAuthorization(admin, {
    authorizationId,
    merchantId,
    amountZar: amount,
    recordOnly,
    paystackSecret: recordOnly ? undefined : secret(),
    platformFee,
  });

  if (!captured.ok) {
    return json({ status: false, message: captured.message }, 400);
  }

  const row = captured.row;
  const finalAmount = Number(row.captured_amount_zar ?? row.amount_zar);

  await appendPlatformPaymentEvent(admin, {
    eventType: 'fare.captured',
    reference: row.capture_reference ?? row.paystack_reference ?? `takasit-cap-${row.id}`,
    app: 'takasit',
    merchantId: row.merchant_id,
    amount: finalAmount,
    currency: row.currency,
    payload: { authorization_id: row.id, reservation_id: row.reservation_id },
  });

  return json({
    status: true,
    amount: finalAmount,
    authorization_id: row.id,
    captured: row.status === 'captured',
    capture_reference: row.capture_reference,
    transaction_id: row.transaction_id,
    message: row.status === 'captured'
      ? 'Fare captured.'
      : 'Capture initiated — confirming settlement.',
  });
}

/** Takasit — release card hold when trip cancelled before capture. */
async function voidPayment(body: Record<string, unknown>) {
  const authorizationId = String(body.authorization_id ?? '').trim();
  const merchantId = String(body.merchant_id ?? '').trim() || undefined;
  const recordOnly = body.record_only === true || body.skip_paystack === true;

  if (!authorizationId) {
    return json({ status: false, message: 'authorization_id is required' }, 400);
  }

  const released = await releaseFareAuthorization(admin, {
    authorizationId,
    merchantId,
    paystackSecret: recordOnly ? undefined : secret(),
    recordOnly,
  });

  if (!released.ok) {
    return json({ status: false, message: released.message }, 400);
  }

  await appendPlatformPaymentEvent(admin, {
    eventType: 'fare.voided',
    reference: released.row.paystack_preauth_reference ?? `takasit-void-${released.row.id}`,
    app: 'takasit',
    merchantId: released.row.merchant_id,
    amount: Number(released.row.amount_zar),
    currency: released.row.currency,
    payload: { authorization_id: released.row.id },
  });

  return json({
    status: true,
    authorization_id: released.row.id,
    voided: true,
    message: 'Card hold released.',
  });
}

async function initMarketplaceCheckout(body: Record<string, unknown>, req: Request) {
  const email = String(body.email ?? '').trim();
  const buyerPhone = String(body.buyer_phone ?? '').trim() || null;
  const buyerAuthorised = body.buyer_authorised === true;
  const buyerAuthorisationText = String(body.buyer_authorisation_text ?? '').trim();
  const cartItemsInput = body.cart_items;

  if (!email) return json({ status: false, message: 'email is required' }, 400);
  if (!buyerAuthorised) {
    return json({ status: false, message: 'Buyer authorisation is required before payment can start' }, 400);
  }
  if (!Array.isArray(cartItemsInput) || !cartItemsInput.length) {
    return json({ status: false, message: 'cart_items is required' }, 400);
  }

  const resolved = await resolveMultiVendorCart(admin, cartItemsInput);
  if ('error' in resolved) {
    return json({ status: false, message: resolved.error }, 400);
  }

  const anchor = [...resolved.vendors].sort((a, b) => b.subtotal - a.subtotal)[0];
  const anchorMerchantId = anchor.merchantId;
  const identity = await resolveCheckoutIdentity(admin, req, body, anchorMerchantId);
  const idempotentEarly = await checkoutIdempotentResponse(identity);
  if (idempotentEarly) return idempotentEarly;

  const amount = resolved.total;
  const currency = resolved.currency || String(body.currency ?? 'ZAR');
  const amountSub = toSubunits(amount);
  const vendorPricing = resolved.vendors.map((vendor) => ({
    vendor,
    pricing: computeVendorPricing(vendor.subtotal, toSubunits, computePricing, vendor),
  }));
  const totalPlatformFee = vendorPricing.reduce((n, row) => n + row.pricing.feeMajor, 0);
  const sharesSum = vendorPricing.reduce((n, row) => n + row.pricing.merchantShareSub, 0);
  if (sharesSum <= 0 || sharesSum > amountSub) {
    return json({ status: false, message: 'Could not compute seller payment split' }, 400);
  }

  const { reference, idempotencyKey, reused } = identity;
  const label = marketplaceCartLabel(resolved.vendors);
  const buyerIp = (req.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || null;
  const buyerUserAgent = req.headers.get('user-agent') || null;

  if (!reused) {
    const { data: checkoutRow, error: checkoutErr } = await admin
      .from('marketplace_checkouts')
      .insert({
        reference,
        buyer_email: email,
        buyer_phone: buyerPhone,
        currency,
        total_amount: amount,
        card_amount: amount,
        platform_fee_total: totalPlatformFee,
        status: 'pending',
        vendor_count: resolved.vendors.length,
        idempotency_key: idempotencyKey,
        buyer_authorised_at: new Date().toISOString(),
        meta: {
          label,
          vendor_ids: resolved.vendors.map((v) => v.merchantId),
        },
      })
      .select('id')
      .single();

    if (checkoutErr || !checkoutRow?.id) {
      console.error('init_marketplace_checkout insert failed', checkoutErr);
      return json({ status: false, message: checkoutErr?.message || 'Could not start checkout' }, 500);
    }

    for (const row of vendorPricing) {
      const { error: vendorErr } = await admin.from('marketplace_checkout_vendors').insert({
        checkout_id: checkoutRow.id,
        merchant_id: row.vendor.merchantId,
        subtotal: row.vendor.subtotal,
        platform_fee: row.pricing.feeMajor,
        merchant_share: row.pricing.merchantShareMajor,
        platform_fee_percent: row.pricing.percent,
        platform_fee_plan: row.pricing.plan,
        paystack_subaccount: row.vendor.paystackSubaccount,
        paystack_share_sub: row.pricing.merchantShareSub,
        cart_items_json: row.vendor.items,
      });
      if (vendorErr) {
        console.error('marketplace_checkout_vendors insert failed', vendorErr);
        return json({ status: false, message: vendorErr.message || 'Could not record seller checkout' }, 500);
      }
    }

    const { error: txErr } = await admin.from('transactions').insert({
      merchant_id: anchorMerchantId,
      reference,
      amount,
      card_amount: amount,
      platform_fee: totalPlatformFee,
      platform_fee_plan: vendorPricing[0]?.pricing.plan ?? 'small',
      platform_fee_percent: vendorPricing[0]?.pricing.percent ?? 2,
      currency,
      status: 'pending',
      buyer_email: email,
      buyer_phone: buyerPhone,
      buyer_authorised: true,
      buyer_authorised_at: new Date().toISOString(),
      buyer_authorisation_text: buyerAuthorisationText
        || `Buyer authorised multi-seller marketplace payment of ${amount} ${currency}`,
      buyer_authorisation_ip: buyerIp,
      buyer_authorisation_user_agent: buyerUserAgent,
      marketplace_checkout_id: checkoutRow.id,
    });
    if (txErr) {
      console.error('init_marketplace_checkout transaction insert failed', txErr);
      return json({ status: false, message: txErr.message || 'Could not record payment' }, 500);
    }

    await logPaymentCreated(body, anchorMerchantId, reference, idempotencyKey, amount, currency);
    for (const row of resolved.vendors) {
      await emitMerchantBusinessEvent(admin, {
        merchantId: row.merchantId,
        eventType: 'payment_started',
        customerEmail: email,
        reference,
        amount: row.subtotal,
        currency,
        source: 'redface-pay',
        idempotencyKey: `pay_start:${reference}:${row.merchantId}`,
        payload: { object_type: 'marketplace_cart', vendor_count: resolved.vendors.length },
      });
    }
  }

  const payload: Record<string, unknown> = {
    email,
    amount: amountSub,
    currency,
    reference,
    callback_url: APP_URL,
    split: buildPaystackFlatSplit(vendorPricing.map((row) => ({
      paystackSubaccount: row.vendor.paystackSubaccount,
      merchantShareSub: row.pricing.merchantShareSub,
    }))),
    metadata: {
      merchant_id: anchorMerchantId,
      object_type: 'marketplace_cart',
      label,
      buyer_email: email,
      buyer_phone: buyerPhone,
      buyer_authorised: true,
      idempotency_key: idempotencyKey,
      platform_fee: totalPlatformFee,
      vendor_count: resolved.vendors.length,
      marketplace_checkout: true,
      ...ecosystemMetadata(body),
    },
  };

  const ps = await initializeCheckout(payload);
  if (!ps?.status) {
    return json({ status: false, message: ps?.message || 'Could not start payment', reference }, 502);
  }

  const checkoutPayload = {
    reference,
    platform_fee: totalPlatformFee,
    platform_fee_plan: vendorPricing[0]?.pricing.plan ?? 'small',
    platform_fee_plan_label: planLabel(vendorPricing[0]?.pricing.plan ?? 'small'),
    platform_fee_percent: vendorPricing[0]?.pricing.percent ?? 2,
    authorization_url: ps.data?.authorization_url,
    access_code: ps.data?.access_code,
    amount,
    card_amount: amount,
    label,
    vendor_count: resolved.vendors.length,
    multi_seller: true,
  };

  await persistCheckoutResponse(anchorMerchantId, idempotencyKey, reference, null, checkoutPayload);

  return json({
    status: true,
    ...checkoutPayload,
  });
}

async function initPayment(body: Record<string, unknown>, req: Request) {
  const merchantId = String(body.merchant_id ?? '');
  const email = String(body.email ?? '');
  const buyerPhone = String(body.buyer_phone ?? '').trim() || null;
  const currency = (body.currency as string) || 'ZAR';
  const productId = String(body.product_id ?? '');
  const buyerAuthorised = body.buyer_authorised === true;
  const buyerAuthorisationText = String(body.buyer_authorisation_text ?? '').trim();

  if (!merchantId || !email) {
    return json({ status: false, message: 'merchant_id and email are required' }, 400);
  }
  if (!buyerAuthorised) {
    return json({ status: false, message: 'Buyer authorisation is required before payment can start' }, 400);
  }

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, business_name, email, status, paystack_subaccount, merchant_plan, subscription_status, platform_fee_percent, platform_fee_cap')
    .eq('id', merchantId)
    .maybeSingle();

  if (!merchant || merchant.status !== 'approved') {
    return json({ status: false, message: 'Merchant not found or not approved' }, 400);
  }

  const sessionIdInput = String(body.payment_session_id ?? '').trim() || null;
  const sessionTokenInput = String(body.payment_session_token ?? '').trim() || null;
  const hasSession = !!(sessionIdInput || sessionTokenInput);

  let product: Record<string, unknown> | null = null;
  const cartItemsInput = body.cart_items;
  const tick3tCheckout = isTick3tCheckout(body);
  // Product catalog carts only. Tick3t ticket lines use ticket_type_id, not product_id.
  const hasCart = Array.isArray(cartItemsInput) && cartItemsInput.length > 0 && !tick3tCheckout;
  let tick3tMeta = tick3tCheckout
    ? tick3tCheckoutMetadata(body, cartItemsInput)
    : bodyMetadataObject(body);

  // Tick3t must never silently settle to the platform main account for third-party sellers.
  if (tick3tCheckout) {
    const { data: settle } = await admin.rpc('tick3t_merchant_commerce_status', {
      p_merchant_id: merchantId,
    });
    const canPay = settle?.ok && settle?.can_receive_payouts === true;
    if (!canPay) {
      return json({
        status: false,
        message:
          'This organizer is not ready to receive payments yet. They need a RedFace Pay settlement subaccount before tickets can be sold.',
      }, 400);
    }
  }

  if (hasSession && hasCart) {
    return json({ status: false, message: 'Payment sessions cannot be used with cart checkout' }, 400);
  }

  if (hasCart) {
    const resolved = await resolveCartItems(admin, merchantId, cartItemsInput);
    if ('error' in resolved) {
      return json({ status: false, message: resolved.error }, 400);
    }
    const amount = resolved.total;
    const storeCreditIdInput = String(body.store_credit_id ?? '').trim() || null;
    let storeCreditId: string | null = null;
    let storeCreditApplied = 0;
    let cardAmount = amount;

    if (storeCreditIdInput) {
      const credit = await resolveStoreCreditForCheckout(admin, storeCreditIdInput, merchantId, email);
      if (!credit.ok) {
        return json({ status: false, message: credit.message }, 400);
      }
      const split = splitStoreCreditAmount(amount, credit.credit.balance_remaining);
      storeCreditId = credit.credit.id;
      storeCreditApplied = split.storeCreditApplied;
      cardAmount = split.cardAmount;
      if (storeCreditApplied <= 0) {
        return json({ status: false, message: 'Store credit balance is zero' }, 400);
      }
    }

    const feeBaseAmount = cardAmount > 0 ? cardAmount : 0;
    const amountSub = toSubunits(feeBaseAmount > 0 ? feeBaseAmount : amount);
    const pricedAmountSub = feeBaseAmount > 0 ? amountSub : 0;
    const pricing = computePricing({
      amountSub: pricedAmountSub,
      plan: feePlanFromMerchant(merchant),
      customPercent: merchant.platform_fee_percent,
      capMajor: merchant.platform_fee_cap,
    });
    const feeSub = pricing.feeSub;
    const platformFee = feeSub / 100;
    const identity = await resolveCheckoutIdentity(admin, req, body, merchantId);
    const { reference, idempotencyKey, reused } = identity;
    const idempotentEarly = await checkoutIdempotentResponse(identity);
    if (idempotentEarly) return idempotentEarly;
    const paymentObjectId = (body.payment_object_id as string) || null;
    const buyerIp = (req.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || null;
    const buyerUserAgent = req.headers.get('user-agent') || null;
    const label = cartLabel(resolved.items);
    const cartJson = JSON.stringify(resolved.items);

    const { error: txErr } = reused ? { error: null } : await admin.from('transactions').insert({
      merchant_id: merchantId,
      reference,
      amount,
      card_amount: cardAmount,
      store_credit_id: storeCreditId,
      store_credit_applied: storeCreditApplied,
      platform_fee: platformFee,
      platform_fee_plan: pricing.plan,
      platform_fee_percent: pricing.percent,
      platform_fee_cap: pricing.cap,
      currency,
      status: 'pending',
      payment_object_id: paymentObjectId,
      buyer_email: email,
      buyer_phone: buyerPhone,
      buyer_authorised: true,
      buyer_authorised_at: new Date().toISOString(),
      buyer_authorisation_text: buyerAuthorisationText || `Buyer authorised cart payment of ${amount} ${currency} to ${merchant.business_name}`,
      buyer_authorisation_ip: buyerIp,
      buyer_authorisation_user_agent: buyerUserAgent,
    });
    if (txErr) {
      console.error('init_payment cart transaction insert failed', txErr);
      return json({ status: false, message: txErr.message || 'Could not record payment' }, 500);
    }

    const { data: txnRow } = await admin
      .from('transactions')
      .select('id')
      .eq('reference', reference)
      .maybeSingle();

    if (cardAmount <= 0 && storeCreditApplied > 0) {
      if (!reused) {
        await logPaymentCreated(body, merchantId, reference, idempotencyKey, amount, currency);
        await emitMerchantBusinessEvent(admin, {
          merchantId,
          eventType: 'payment_started',
          customerEmail: email,
          productId: resolved.items.length === 1 ? resolved.items[0].product_id : null,
          reference,
          amount,
          currency,
          source: 'redface-pay',
          idempotencyKey: `pay_start:${reference}`,
          payload: { object_type: 'cart', item_count: resolved.items.length },
        });
      }

      const redeem = await redeemStoreCreditIfNeeded(admin, {
        creditId: storeCreditId,
        merchantId,
        buyerEmail: email,
        amount: storeCreditApplied,
        reference,
        transactionId: txnRow?.id ?? null,
      });
      if (!redeem.ok) {
        await admin.from('transactions').update({ status: 'failed' }).eq('reference', reference);
        return json({ status: false, message: redeem.message || 'Could not apply store credit' }, 400);
      }

      await admin.from('transactions').update({ status: 'success' }).eq('reference', reference);
      await recordPaymentLedgerEntry(admin, { reference, processingRail: 'store_credit' });
      const { completeBuyerPaymentIntents } = await import('../_shared/buyerPaymentIntents.ts');
      await completeBuyerPaymentIntents(admin, { reference });

      let orderNumber: string | null = null;
      const order = await createOrderFromPayment(admin, {
        reference,
        merchantId,
        amount,
        currency,
        buyerEmail: email,
        buyerPhone,
        purchaseType: 'cart',
        cartItemsJson: cartJson,
        label,
        productId: resolved.items.length === 1 ? resolved.items[0].product_id : null,
      });
      if (order.ok && order.order_number) orderNumber = order.order_number;

      return json({
        status: true,
        payment_method: 'store_credit',
        reference,
        amount,
        store_credit_applied: storeCreditApplied,
        card_amount: 0,
        platform_fee: 0,
        order_number: orderNumber,
        label,
      });
    }

    if (!reused) {
      await logPaymentCreated(body, merchantId, reference, idempotencyKey, amount, currency);
      await emitMerchantBusinessEvent(admin, {
        merchantId,
        eventType: 'payment_started',
        customerEmail: email,
        productId: resolved.items.length === 1 ? resolved.items[0].product_id : null,
        reference,
        amount,
        currency,
        source: 'redface-pay',
        idempotencyKey: `pay_start:${reference}`,
        payload: { object_type: 'cart', item_count: resolved.items.length },
      });
    }

    const payload: Record<string, unknown> = {
      email,
      amount: amountSub,
      currency,
      reference,
      callback_url: APP_URL,
      metadata: {
        merchant_id: merchantId,
        payment_object_id: body.payment_object_id ?? null,
        object_type: 'cart',
        label,
        product_id: resolved.items.length === 1 ? resolved.items[0].product_id : null,
        cart_items_json: cartJson,
        buyer_email: email,
        buyer_phone: buyerPhone,
        buyer_authorised: true,
        idempotency_key: idempotencyKey,
        platform_fee: platformFee,
        platform_fee_plan: pricing.plan,
        platform_fee_percent: pricing.percent,
        platform_fee_cap: pricing.cap,
        store_credit_applied: storeCreditApplied,
        store_credit_id: storeCreditId,
        ...ecosystemMetadata(body),
      },
    };

    if (cardAmount <= 0) {
      return json({ status: false, message: 'Invalid payment amount' }, 400);
    }

    const amountTooSmall = assertCardAmountViable(amountSub, currency);
    if (amountTooSmall) {
      return json({ status: false, message: amountTooSmall, reference }, 400);
    }

    applyMerchantRouting(payload, merchant, feeSub, amountSub, currency);
    const ps = await initializeCheckout(payload);
    if (!ps?.status) {
      const friendly = friendlyPaystackInitError(ps?.message, currency);
      return json({ status: false, message: friendly.message, reference }, friendly.status);
    }

    const cartCheckoutPayload = {
      reference,
      platform_fee: platformFee,
      platform_fee_plan: pricing.plan,
      platform_fee_plan_label: planLabel(pricing.plan),
      platform_fee_percent: pricing.percent,
      platform_fee_cap: pricing.cap,
      authorization_url: ps.data?.authorization_url,
      access_code: ps.data?.access_code,
      amount,
      store_credit_applied: storeCreditApplied,
      card_amount: cardAmount,
      label,
    };

    await persistCheckoutResponse(merchantId, idempotencyKey, reference, null, cartCheckoutPayload);

    return json({
      status: true,
      ...cartCheckoutPayload,
    });
  }

  if (productId) {
    const { data: p } = await admin.from('products').select('*').eq('id', productId).eq('merchant_id', merchantId).maybeSingle();
    if (!p) return json({ status: false, message: 'Product not found' }, 404);
    product = p as Record<string, unknown>;
    if (p.billing_type === 'subscription') {
      return initProductSubscriptionPayment(body, req, merchant, product, email, currency, buyerAuthorisationText);
    }
  }

  const invoiceId = String(body.invoice_id ?? '').trim();
  const invoicePaymentKind = String(body.payment_kind ?? body.pay_kind ?? 'full').toLowerCase() as InvoicePaymentKind;
  let invoiceRow: Record<string, unknown> | null = null;
  let invoiceCheckoutLabel: string | null = null;
  if (invoiceId) {
    const checkout = await resolveInvoiceCheckout(admin, invoiceId, invoicePaymentKind);
    if (!checkout.ok) {
      return json({ status: false, message: checkout.error || 'Invoice not available for payment' }, 400);
    }
    const { data: inv } = await admin
      .from('merchant_invoices')
      .select('id, merchant_id, total, status, invoice_number, amount_paid, deposit_percent')
      .eq('id', invoiceId)
      .eq('merchant_id', merchantId)
      .maybeSingle();
    if (!inv) {
      return json({ status: false, message: 'Invoice not found' }, 400);
    }
    invoiceRow = inv as Record<string, unknown>;
    invoiceCheckoutLabel = checkout.label ?? `Invoice ${inv.invoice_number}`;
  }

  if (hasSession && (productId || invoiceId)) {
    return json({ status: false, message: 'Payment sessions cannot be used with products or invoices' }, 400);
  }

  let paymentSession: PaymentSessionRow | null = null;
  let paymentSessionMeta: Record<string, unknown> = {};
  let amount = Number(body.amount ?? 0);
  if (hasSession) {
    await admin.rpc('expire_payment_sessions').then(() => {}, () => {});
    let sq = admin
      .from('payment_sessions')
      .select('id, merchant_id, payment_object_id, public_token, amount, currency, label, status, expires_at, cart_items, metadata')
      .eq('merchant_id', merchantId)
      .in('status', ['waiting', 'opened', 'processing'])
      .gt('expires_at', new Date().toISOString());
    if (sessionIdInput) sq = sq.eq('id', sessionIdInput);
    else sq = sq.eq('public_token', sessionTokenInput!);
    const { data: sess } = await sq.maybeSingle();
    if (!sess) {
      return json({ status: false, message: 'Payment session not found or expired. Ask the merchant to press Ready again.' }, 400);
    }
    paymentSession = sess as PaymentSessionRow;
    paymentSessionMeta = paymentSession.metadata && typeof paymentSession.metadata === 'object'
      ? paymentSession.metadata
      : {};
    amount = Number(paymentSession.amount);
  } else if (product) {
    amount = Number(product.price ?? 0);
  } else if (invoiceRow) {
    const checkout = await resolveInvoiceCheckout(admin, invoiceId, invoicePaymentKind);
    amount = Number(checkout.amount ?? invoiceRow.total ?? 0);
  } else if (tick3tCheckout) {
    const priced = await priceTick3tCheckout(admin, merchantId, tick3tMeta);
    if (!priced.ok) {
      return json({ status: false, message: priced.message }, 400);
    }
    amount = priced.amount;
    tick3tMeta = priced.meta;
  }
  if (!amount || amount <= 0) {
    return json({ status: false, message: 'amount is required' }, 400);
  }

  const storeCreditIdInput = String(body.store_credit_id ?? '').trim() || null;

  let storeCreditId: string | null = null;
  let storeCreditApplied = 0;
  let cardAmount = amount;
  if (storeCreditIdInput) {
    const credit = await resolveStoreCreditForCheckout(admin, storeCreditIdInput, merchantId, email);
    if (!credit.ok) {
      return json({ status: false, message: credit.message }, 400);
    }
    const split = splitStoreCreditAmount(amount, credit.credit.balance_remaining);
    storeCreditId = credit.credit.id;
    storeCreditApplied = split.storeCreditApplied;
    cardAmount = split.cardAmount;
    if (storeCreditApplied <= 0) {
      return json({ status: false, message: 'Store credit balance is zero' }, 400);
    }
  }

  const feeBaseAmount = cardAmount > 0 ? cardAmount : 0;
  const amountSub = toSubunits(feeBaseAmount > 0 ? feeBaseAmount : amount);
  const pricedAmountSub = feeBaseAmount > 0 ? amountSub : 0;
  const pricing = computePricing({
    amountSub: pricedAmountSub,
    plan: feePlanFromMerchant(merchant),
    customPercent: merchant.platform_fee_percent,
    capMajor: merchant.platform_fee_cap,
  });
  const feeSub = pricing.feeSub;
  const platformFee = feeSub / 100;
  const identity = await resolveCheckoutIdentity(admin, req, body, merchantId);
  const { reference, idempotencyKey, reused } = identity;
  const idempotentEarly = await checkoutIdempotentResponse(identity);
  if (idempotentEarly) return idempotentEarly;
  let paymentObjectId = (body.payment_object_id as string) || null;
  if (paymentSession?.payment_object_id) {
    paymentObjectId = paymentSession.payment_object_id;
  }

  if (paymentSession) {
    const validated = await validatePaymentSessionForInit(admin, {
      sessionId: paymentSession.id,
      sessionToken: paymentSession.public_token,
      merchantId,
      amount,
      reference,
    });
    if (!validated.ok) {
      return json({ status: false, message: validated.message }, 400);
    }
    paymentSession = validated.session;
  }

  const buyerIp = (req.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || null;
  const buyerUserAgent = req.headers.get('user-agent') || null;
  const sessionLabel = paymentSession?.label || invoiceCheckoutLabel || String(body.label ?? '').trim() || null;
  let sessionCartJson: string | null = null;
  const sessionCartRaw = paymentSession?.cart_items;
  if (Array.isArray(sessionCartRaw) && sessionCartRaw.length > 0) {
    sessionCartJson = JSON.stringify(sessionCartRaw);
  }

  // Record the attempt up front so it appears in dashboards even if the
  // customer abandons checkout. The webhook flips it to success/failed.
  const ecoMeta = ecosystemMetadata(body);
  const ecoApp = String(ecoMeta.ecosystem_app ?? '').toLowerCase();
  const sessionLabelText = sessionLabel || String(body.label ?? '').trim() || null;
  const checkoutMetaForTxn = tick3tCheckout
    ? tick3tMeta
    : Object.keys(tick3tMeta).length
      ? tick3tMeta
      : (ecoApp
        ? {
            ...ecoMeta,
            label: sessionLabelText,
            purpose: body.purpose ?? null,
            ecosystem_app: ecoApp,
          }
        : null);
  const { error: txErr } = reused ? { error: null } : await admin.from('transactions').insert({
    merchant_id: merchantId,
    reference,
    amount,
    card_amount: cardAmount,
    store_credit_id: storeCreditId,
    store_credit_applied: storeCreditApplied,
    platform_fee: platformFee,
    platform_fee_plan: pricing.plan,
    platform_fee_percent: pricing.percent,
    platform_fee_cap: pricing.cap,
    currency: paymentSession?.currency || currency,
    status: 'pending',
    payment_object_id: paymentObjectId,
    payment_session_id: paymentSession?.id ?? null,
    buyer_email: email,
    buyer_phone: buyerPhone,
    buyer_authorised: true,
    buyer_authorised_at: new Date().toISOString(),
    buyer_authorisation_text: buyerAuthorisationText || `Buyer authorised payment of ${amount} ${currency} to ${merchant.business_name}`,
    buyer_authorisation_ip: buyerIp,
    buyer_authorisation_user_agent: buyerUserAgent,
    ...(checkoutMetaForTxn ? { checkout_metadata: checkoutMetaForTxn } : {}),
  });
  if (txErr) {
    console.error('init_payment transaction insert failed', txErr);
    return json({ status: false, message: txErr.message || 'Could not record payment' }, 500);
  }

  const { data: txnRow } = await admin
    .from('transactions')
    .select('id')
    .eq('reference', reference)
    .maybeSingle();

  if (cardAmount <= 0 && storeCreditApplied > 0) {
    if (!reused) {
      await logPaymentCreated(body, merchantId, reference, idempotencyKey, amount, currency);
      await emitMerchantBusinessEvent(admin, {
        merchantId,
        eventType: 'payment_started',
        customerEmail: email,
        productId: productId || null,
        reference,
        amount,
        currency,
        source: 'redface-pay',
        idempotencyKey: `pay_start:${reference}`,
        payload: { object_type: body.object_type ?? null, invoice_id: invoiceId || null },
      });
    }

    const redeem = await redeemStoreCreditIfNeeded(admin, {
      creditId: storeCreditId,
      merchantId,
      buyerEmail: email,
      amount: storeCreditApplied,
      reference,
      transactionId: txnRow?.id ?? null,
    });
    if (!redeem.ok) {
      if (paymentSession?.id) await reopenPaymentSession(admin, paymentSession.id);
      await admin.from('transactions').update({ status: 'failed' }).eq('reference', reference);
      return json({ status: false, message: redeem.message || 'Could not apply store credit' }, 400);
    }

    await admin.from('transactions').update({ status: 'success' }).eq('reference', reference);
    await markSessionPaid(admin, reference, txnRow?.id ?? null);
    const { completeBuyerPaymentIntents } = await import('../_shared/buyerPaymentIntents.ts');
    await completeBuyerPaymentIntents(admin, { reference });

    if (invoiceId) {
      const checkout = await resolveInvoiceCheckout(admin, invoiceId, invoicePaymentKind);
      await applyInvoicePayment(
        admin,
        invoiceId,
        Number(checkout.amount ?? amount),
        reference,
        (checkout.payment_kind ?? invoicePaymentKind) as InvoicePaymentKind,
      );
    }

    let orderNumber: string | null = null;
    if (txnRow?.id && email) {
      const order = await createOrderFromPayment(admin, {
        reference,
        merchantId,
        amount,
        currency: paymentSession?.currency || currency,
        buyerEmail: email,
        buyerPhone,
      });
      if (order.ok && order.order_number) orderNumber = order.order_number;
    }

    return json({
      status: true,
      payment_method: 'store_credit',
      reference,
      amount,
      store_credit_applied: storeCreditApplied,
      card_amount: 0,
      platform_fee: 0,
      order_number: orderNumber,
    });
  }

  if (!reused) {
    await logPaymentCreated(body, merchantId, reference, idempotencyKey, amount, currency);
    await emitMerchantBusinessEvent(admin, {
      merchantId,
      eventType: 'payment_started',
      customerEmail: email,
      productId: productId || null,
      reference,
      amount,
      currency,
      source: 'redface-pay',
      idempotencyKey: `pay_start:${reference}`,
      payload: { object_type: body.object_type ?? null, invoice_id: invoiceId || null },
    });
  }

  const posSaleId = String(paymentSessionMeta.pos_sale_id ?? '').trim() || null;

  const paystackExtraMeta: Record<string, unknown> = { ...tick3tMeta };
  if (Array.isArray(paystackExtraMeta.cart_items)) {
    if (!paystackExtraMeta.cart_items_json) {
      paystackExtraMeta.cart_items_json = JSON.stringify(paystackExtraMeta.cart_items);
    }
    delete paystackExtraMeta.cart_items;
  }

  const payload: Record<string, unknown> = {
    email,
    amount: amountSub,
    currency: paymentSession?.currency || currency,
    reference,
    callback_url: APP_URL,
    metadata: {
      merchant_id: merchantId,
      payment_object_id: paymentObjectId,
      payment_session_id: paymentSession?.id ?? null,
      object_type: sessionCartJson ? 'cart' : (body.object_type ?? null),
      label: sessionLabel,
      product_id: productId || null,
      invoice_id: invoiceId || null,
      invoice_payment_kind: invoiceId ? (invoicePaymentKind || 'full') : null,
      invoice_checkout_amount: invoiceId ? amount : null,
      buyer_email: email,
      buyer_phone: buyerPhone,
      buyer_authorised: true,
      buyer_authorised_at: new Date().toISOString(),
      idempotency_key: idempotencyKey,
      platform_fee: platformFee,
      platform_fee_plan: pricing.plan,
      platform_fee_percent: pricing.percent,
      platform_fee_cap: pricing.cap,
      store_credit_applied: storeCreditApplied,
      store_credit_id: storeCreditId,
      ...(posSaleId ? { pos_sale_id: posSaleId, split_tender: 'card' } : {}),
      ...(sessionCartJson ? { cart_items_json: sessionCartJson } : {}),
      ...ecosystemMetadata(body),
      ...paystackExtraMeta,
    },
  };

  if (cardAmount <= 0) {
    return json({ status: false, message: 'Invalid payment amount' }, 400);
  }

  const amountTooSmall = assertCardAmountViable(amountSub, paymentSession?.currency || currency);
  if (amountTooSmall) {
    return json({ status: false, message: amountTooSmall, reference }, 400);
  }

  applyMerchantRouting(payload, merchant, feeSub, amountSub, paymentSession?.currency || currency);

  const ps = await initializeCheckout(payload);
  if (!ps?.status) {
    if (paymentSession?.id) {
      await reopenPaymentSession(admin, paymentSession.id);
    }
    const friendly = friendlyPaystackInitError(ps?.message, paymentSession?.currency || currency);
    return json({ status: false, message: friendly.message, reference }, friendly.status);
  }

  const checkoutPayload = {
    reference,
    amount,
    store_credit_applied: storeCreditApplied,
    card_amount: cardAmount,
    platform_fee: platformFee,
    platform_fee_plan: pricing.plan,
    platform_fee_plan_label: planLabel(pricing.plan),
    platform_fee_percent: pricing.percent,
    platform_fee_cap: pricing.cap,
    authorization_url: ps.data?.authorization_url,
    access_code: ps.data?.access_code,
  };

  await persistCheckoutResponse(
    merchantId,
    idempotencyKey,
    reference,
    paymentSession?.id ?? null,
    checkoutPayload,
  );

  return json({
    status: true,
    ...checkoutPayload,
  });
}

async function initProductSubscriptionPayment(
  body: Record<string, unknown>,
  req: Request,
  merchant: Record<string, unknown>,
  product: Record<string, unknown>,
  email: string,
  currency: string,
  buyerAuthorisationText: string,
) {
  const merchantId = String(merchant.id);
  const amount = Number(product.price);
  if (!(amount > 0)) return json({ status: false, message: 'Subscription product has no price' }, 400);

  const idempotencyKey = ensureIdempotencyKey(
    readIdempotencyKey(req, body) || `product_sub:${merchantId}:${String(product.id)}:${email}`,
  );
  const resumed = await tryResumeCompletedRequest(admin, merchantId, idempotencyKey, 'subscription', {
    product_id: product.id,
    buyer_email: email,
  });
  if (resumed.hit) {
    return json({
      status: true,
      idempotent: true,
      retry_count: resumed.retryCount,
      subscription: true,
      ...resumed.payload,
    });
  }

  const interval = String(product.subscription_interval ?? 'monthly');
  const planCode = await getOrCreateProductPlan(product, currency);
  const amountSub = toSubunits(amount);
  const pricing = computePricing({
    amountSub,
    plan: feePlanFromMerchant(merchant),
    customPercent: merchant.platform_fee_percent as number | null,
    capMajor: merchant.platform_fee_cap as number | null,
  });
  const feeSub = pricing.feeSub;
  const platformFee = feeSub / 100;
  const reference = `rfs_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const paymentObjectId = (body.payment_object_id as string) || null;
  const buyerIp = (req.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || null;
  const buyerUserAgent = req.headers.get('user-agent') || null;

  const { data: subRow, error: subErr } = await admin.from('customer_subscriptions').insert({
    merchant_id: merchantId,
    product_id: product.id,
    buyer_email: email,
    product_name: product.name,
    amount,
    currency,
    subscription_interval: interval,
    status: 'pending',
    paystack_plan_code: planCode,
    paystack_reference: reference,
    meta: { checkout_started_at: new Date().toISOString() },
  }).select('*').single();
  if (subErr || !subRow) return json({ status: false, message: subErr?.message || 'Could not save subscription' }, 500);

  await admin.from('transactions').insert({
    merchant_id: merchantId,
    reference,
    amount,
    platform_fee: platformFee,
    platform_fee_plan: pricing.plan,
    platform_fee_percent: pricing.percent,
    platform_fee_cap: pricing.cap,
    currency,
    status: 'pending',
    payment_object_id: paymentObjectId,
    buyer_email: email,
    buyer_authorised: true,
    buyer_authorised_at: new Date().toISOString(),
    buyer_authorisation_text: buyerAuthorisationText || `Buyer subscribed to ${product.name} at ${amount} ${currency}/${interval}`,
    buyer_authorisation_ip: buyerIp,
    buyer_authorisation_user_agent: buyerUserAgent,
  });

  const payload: Record<string, unknown> = {
    email,
    plan: planCode,
    currency,
    reference,
    callback_url: APP_URL,
    metadata: {
      purchase_type: 'product_subscription',
      merchant_id: merchantId,
      product_id: product.id,
      customer_subscription_id: subRow.id,
      label: product.name,
      buyer_authorised: true,
      platform_fee: platformFee,
      platform_fee_plan: pricing.plan,
      platform_fee_percent: pricing.percent,
      platform_fee_cap: pricing.cap,
    },
  };

  const amountTooSmall = assertCardAmountViable(amountSub, currency);
  if (amountTooSmall) {
    await admin.from('customer_subscriptions').update({ status: 'failed' }).eq('id', subRow.id);
    return json({ status: false, message: amountTooSmall, reference }, 400);
  }
  applyMerchantRouting(payload, merchant, feeSub, amountSub, currency);

  const ps = await initializeCheckout(payload);
  if (!ps?.status) {
    await admin.from('customer_subscriptions').update({ status: 'failed' }).eq('id', subRow.id);
    const friendly = friendlyPaystackInitError(ps?.message, currency);
    return json({ status: false, message: friendly.message, reference }, friendly.status);
  }

  const subscriptionPayload = {
    reference,
    platform_fee: platformFee,
    platform_fee_plan: pricing.plan,
    platform_fee_plan_label: planLabel(pricing.plan),
    platform_fee_percent: pricing.percent,
    platform_fee_cap: pricing.cap,
    authorization_url: ps.data?.authorization_url,
    access_code: ps.data?.access_code,
    customer_subscription_id: subRow.id,
  };

  await completePaymentRequest(admin, {
    merchantId,
    idempotencyKey,
    requestType: 'subscription',
    status: 'completed',
    transactionReference: reference,
    responsePayload: subscriptionPayload,
  });

  return json({
    status: true,
    subscription: true,
    ...subscriptionPayload,
  });
}

// Any signed-in user buys a domain — payment goes to RedFace (not a merchant
// subaccount). The domain is owned by the USER (user_domains); if the buyer is
// also a merchant it is linked to that merchant for storefront use. After the
// Paystack webhook confirms payment, name.com registration runs automatically.
async function initDomainPayment(body: Record<string, unknown>, req: Request) {
  const who = await requireUser(req);
  if (!who) return json({ status: false, message: 'Sign in to buy a domain.' }, 401);

  const domainName = String(body.domainName ?? '').trim().toLowerCase();
  if (!domainName) return json({ status: false, message: 'domainName is required' }, 400);

  const check = await checkAvailability(domainName);
  const hit = check.hit;
  if (!check.ok) {
    const errPayload = check.error as { error?: string } | string | null;
    const apiMsg = typeof errPayload === 'string'
      ? errPayload
      : (errPayload && typeof errPayload === 'object' ? errPayload.error : null);
    if (typeof apiMsg === 'string' && apiMsg.includes('not configured')) {
      return json({ status: false, message: 'Domain registration is not configured yet. Checkout is disabled until name.com API keys are set.' }, 503);
    }
    return json({ status: false, message: 'Domain is not available for registration.' }, 400);
  }
  if (!hit?.purchasable || hit.purchaseType !== 'registration') {
    return json({ status: false, message: 'Domain is not available for registration.' }, 400);
  }
  if (hit.purchasePrice == null || Number(hit.purchasePrice) <= 0) {
    return json({ status: false, message: 'Could not determine domain price. Try again.' }, 400);
  }

  const { data: existing } = await admin
    .from('user_domains')
    .select('id, user_id, status')
    .eq('domain_name', domainName)
    .maybeSingle();
  if (existing && existing.user_id !== who.userId) {
    return json({
      status: false,
      message: existing.status === 'active'
        ? 'This domain is already registered to another account.'
        : 'This domain is already reserved by another account.',
    }, 409);
  }

  const checkoutAmount = domainCheckoutZar(Number(hit.purchasePrice));
  const currency = 'ZAR';
  const reference = `rfd_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const merchantId = who.merchant?.id ?? null;

  const orderPayload = {
    user_id: who.userId,
    merchant_id: merchantId,
    domain_name: domainName,
    status: 'awaiting_payment',
    premium: !!hit.premium,
    purchase_type: hit.purchaseType || 'registration',
    purchase_price_usd: hit.purchasePrice,
    paystack_reference: reference,
    checkout_amount: checkoutAmount,
    checkout_currency: currency,
    meta: { checkout_started_at: new Date().toISOString(), usd_cost: hit.purchasePrice },
    updated_at: new Date().toISOString(),
  };

  // user_domains has a unique index on lower(domain_name), not domain_name itself,
  // so PostgREST upsert(onConflict: domain_name) fails — update or insert explicitly.
  let row: Record<string, unknown> | null = null;
  let rowErr: { message?: string } | null = null;
  if (existing?.user_id === who.userId) {
    const out = await admin.from('user_domains').update(orderPayload).eq('id', existing.id).select('*').single();
    row = out.data;
    rowErr = out.error;
  } else {
    const out = await admin.from('user_domains').insert(orderPayload).select('*').single();
    row = out.data;
    rowErr = out.error;
  }

  if (rowErr || !row) {
    const msg = rowErr?.message || 'Could not save domain order';
    if (msg.includes('user_domains') && msg.includes('does not exist')) {
      return json({ status: false, message: 'Domain checkout is not set up yet. Apply migration 0046_user_assets.sql in Supabase.' }, 500);
    }
    return json({ status: false, message: msg }, 500);
  }

  const ps = await initializeCheckout({
    email: who.email,
    amount: toSubunits(checkoutAmount),
    currency,
    reference,
    callback_url: `${APP_URL}?domain=success`,
    metadata: {
      purchase_type: 'domain',
      user_domain_row_id: row.id,
      domain_name: domainName,
      user_id: who.userId,
      merchant_id: merchantId,
      checkout_amount: checkoutAmount,
      usd_cost: hit.purchasePrice,
    },
  });

  if (!ps?.status) {
    await admin.from('user_domains').update({ status: 'pending', paystack_reference: null }).eq('id', row.id);
    return json({ status: false, message: ps?.message || 'Could not start payment' }, 502);
  }

  return json({
    status: true,
    reference,
    checkout_amount: checkoutAmount,
    checkout_currency: currency,
    domain_row_id: row.id,
    domain_name: domainName,
    authorization_url: ps.data?.authorization_url,
    access_code: ps.data?.access_code,
  });
}

async function initDomainRenewalPayment(body: Record<string, unknown>, req: Request) {
  const who = await requireUser(req);
  if (!who) return json({ status: false, message: 'Sign in to renew your domain.' }, 401);

  const domainRowId = String(body.domainRowId ?? '');
  const years = Math.min(10, Math.max(1, Number(body.years || 1)));
  if (!domainRowId) return json({ status: false, message: 'domainRowId is required' }, 400);

  const { data: row, error } = await admin
    .from('user_domains')
    .select('*')
    .eq('id', domainRowId)
    .eq('user_id', who.userId)
    .maybeSingle();
  if (error) return json({ status: false, message: error.message }, 500);
  if (!row) return json({ status: false, message: 'Domain not found for your account.' }, 404);
  if (row.status !== 'active') {
    return json({ status: false, message: 'This domain is not active yet. Complete registration first.' }, 400);
  }

  const pricingOut = await fetchRenewalPricing(row.domain_name, years);
  if (!pricingOut.ok || !pricingOut.pricing) {
    return json({ status: false, message: pricingOut.message || 'Could not load renewal price.' }, 502);
  }
  const { checkoutAmountZar, renewalPriceUsd, currency } = pricingOut.pricing;

  const reference = `rfr_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const meta = {
    ...(row.meta || {}),
    renewal_checkout: {
      reference,
      years,
      renewal_price_usd: renewalPriceUsd,
      checkout_amount: checkoutAmountZar,
      checkout_currency: currency,
      started_at: new Date().toISOString(),
    },
  };
  await admin.from('user_domains').update({ meta, updated_at: new Date().toISOString() }).eq('id', row.id);

  const ps = await initializeCheckout({
    email: who.email,
    amount: toSubunits(checkoutAmountZar),
    currency,
    reference,
    callback_url: `${APP_URL}?domain=renewed`,
    metadata: {
      purchase_type: 'domain_renewal',
      user_domain_row_id: row.id,
      domain_name: row.domain_name,
      user_id: who.userId,
      merchant_id: row.merchant_id,
      renewal_years: years,
      renewal_price_usd: renewalPriceUsd,
      checkout_amount: checkoutAmountZar,
    },
  });

  if (!ps?.status) {
    const cleared = { ...(row.meta || {}) };
    delete (cleared as Record<string, unknown>).renewal_checkout;
    await admin.from('user_domains').update({ meta: cleared }).eq('id', row.id);
    return json({ status: false, message: ps?.message || 'Could not start renewal payment' }, 502);
  }

  return json({
    status: true,
    reference,
    checkout_amount: checkoutAmountZar,
    checkout_currency: currency,
    renewal_price_usd: renewalPriceUsd,
    years,
    domain_row_id: row.id,
    domain_name: row.domain_name,
    authorization_url: ps.data?.authorization_url,
    access_code: ps.data?.access_code,
  });
}

async function getOrCreatePremiumPlan(merchantId: string, amountMajor: number, currency: string): Promise<string> {
  if (PREMIUM_PLAN_CODE) return PREMIUM_PLAN_CODE;

  const { data: existing } = await admin
    .from('merchant_subscriptions')
    .select('paystack_plan_code')
    .eq('merchant_id', merchantId)
    .eq('amount', amountMajor)
    .eq('currency', currency)
    .not('paystack_plan_code', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.paystack_plan_code) return existing.paystack_plan_code;

  const ps = await paystackPost('/plan', {
    name: `RedFace Premium ${merchantId.slice(0, 8)}`,
    interval: 'monthly',
    amount: toSubunits(amountMajor),
    currency,
  });
  if (!ps?.status || !ps.data?.plan_code) {
    throw new Error(ps?.message || 'Could not create Paystack plan');
  }
  return ps.data.plan_code as string;
}

async function initPlanSubscription(body: Record<string, unknown>, req: Request) {
  const who = await requireMerchant(req);
  if (!who) return json({ status: false, message: 'Sign in as an approved merchant.' }, 401);

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, email, merchant_plan, subscription_status, monthly_subscription_fee')
    .eq('id', who.merchant.id)
    .maybeSingle();
  if (!merchant) return json({ status: false, message: 'Merchant not found.' }, 404);

  if (merchant.merchant_plan === 'premium' && merchant.subscription_status === 'active') {
    return json({ status: false, message: 'Premium subscription is already active.' }, 400);
  }

  const idempotencyKey = ensureIdempotencyKey(
    readIdempotencyKey(req, body) || `plan_sub:${merchant.id}`,
  );
  const resumed = await tryResumeCompletedRequest(admin, merchant.id, idempotencyKey, 'subscription', {
    plan: 'premium',
  });
  if (resumed.hit) {
    return json({
      status: true,
      idempotent: true,
      retry_count: resumed.retryCount,
      ...resumed.payload,
    });
  }

  const fee = Number(merchant.monthly_subscription_fee) > 0
    ? Number(merchant.monthly_subscription_fee)
    : PREMIUM_SUBSCRIPTION_ZAR;
  const currency = 'ZAR';
  const planCode = await getOrCreatePremiumPlan(merchant.id, fee, currency);
  const reference = `rfp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  const { data: row, error: rowErr } = await admin.from('merchant_subscriptions').insert({
    merchant_id: merchant.id,
    plan: 'premium',
    amount: fee,
    currency,
    status: 'pending',
    paystack_plan_code: planCode,
    paystack_reference: reference,
    meta: { checkout_started_at: new Date().toISOString() },
  }).select('*').single();

  if (rowErr || !row) return json({ status: false, message: rowErr?.message || 'Could not save subscription' }, 500);

  const ps = await initializeCheckout({
    email: merchant.email,
    plan: planCode,
    reference,
    currency,
    callback_url: `${APP_URL}?subscription=success`,
    metadata: {
      purchase_type: 'plan_subscription',
      merchant_id: merchant.id,
      subscription_row_id: row.id,
      monthly_fee: fee,
    },
  });

  if (!ps?.status) {
    await admin.from('merchant_subscriptions').update({ status: 'failed' }).eq('id', row.id);
    return json({ status: false, message: ps?.message || 'Could not start subscription checkout' }, 502);
  }

  const planPayload = {
    reference,
    amount: fee,
    currency,
    plan_code: planCode,
    subscription_row_id: row.id,
    authorization_url: ps.data?.authorization_url,
    access_code: ps.data?.access_code,
  };

  await completePaymentRequest(admin, {
    merchantId: merchant.id,
    idempotencyKey,
    requestType: 'subscription',
    status: 'completed',
    transactionReference: reference,
    responsePayload: planPayload,
  });

  return json({
    status: true,
    ...planPayload,
  });
}

async function cancelCustomerSubscription(body: Record<string, unknown>, req: Request) {
  const who = await requireUser(req);
  if (!who) return json({ status: false, message: 'Sign in to manage subscriptions.' }, 401);

  const subscriptionId = String(body.subscription_id ?? '');
  if (!subscriptionId) return json({ status: false, message: 'subscription_id is required.' }, 400);

  const { data: sub } = await admin
    .from('customer_subscriptions')
    .select('id, buyer_email, status, paystack_subscription_code')
    .eq('id', subscriptionId)
    .maybeSingle();

  if (!sub) return json({ status: false, message: 'Subscription not found.' }, 404);
  if (sub.buyer_email.toLowerCase() !== who.email) {
    return json({ status: false, message: 'Not authorized.' }, 403);
  }
  if (!['active', 'past_due'].includes(sub.status)) {
    return json({ status: false, message: 'This subscription is not active.' }, 400);
  }
  if (!sub.paystack_subscription_code) {
    return json({ status: false, message: 'Subscription cannot be cancelled online.' }, 400);
  }

  const ps = await disablePaystackSubscription(secret(), sub.paystack_subscription_code);
  if (!ps?.status) {
    return json({ status: false, message: ps?.message || 'Could not cancel subscription with Paystack.' }, 502);
  }

  await admin.from('customer_subscriptions').update({
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
  }).eq('id', sub.id);

  return json({
    status: true,
    message: 'Subscription cancelled. Access continues until the current billing period ends.',
  });
}

async function cancelPlanSubscription(req: Request) {
  const who = await requireMerchant(req);
  if (!who) return json({ status: false, message: 'Sign in as an approved merchant.' }, 403);

  const { data: sub } = await admin
    .from('merchant_subscriptions')
    .select('id, status, paystack_subscription_code')
    .eq('merchant_id', who.merchant.id)
    .in('status', ['active', 'past_due'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!sub?.paystack_subscription_code) {
    return json({ status: false, message: 'No active Premium subscription to cancel.' }, 400);
  }

  const ps = await disablePaystackSubscription(secret(), sub.paystack_subscription_code);
  if (!ps?.status) {
    return json({ status: false, message: ps?.message || 'Could not cancel subscription.' }, 502);
  }

  await admin.from('merchant_subscriptions').update({
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
  }).eq('id', sub.id);

  await admin.from('merchants').update({
    ...freePlanPatch(),
  }).eq('id', who.merchant.id);

  return json({
    status: true,
    message: 'Premium cancelled. Access continues until the current billing period ends.',
  });
}

async function getOrCreateDeveloperApiPlan(
  merchantId: string,
  tier: PaidDeveloperTier,
  amountMajor: number,
  currency: string,
): Promise<string> {
  const { data: existing } = await admin
    .from('merchant_developer_subscriptions')
    .select('paystack_plan_code')
    .eq('merchant_id', merchantId)
    .eq('tier', tier)
    .eq('amount', amountMajor)
    .eq('currency', currency)
    .not('paystack_plan_code', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.paystack_plan_code) return existing.paystack_plan_code;

  const ps = await paystackPost('/plan', {
    name: `RedFace API ${tier} ${merchantId.slice(0, 8)}`,
    interval: 'monthly',
    amount: toSubunits(amountMajor),
    currency,
  });
  if (!ps?.status || !ps.data?.plan_code) {
    throw new Error(ps?.message || 'Could not create Paystack plan');
  }
  return ps.data.plan_code as string;
}

async function activateDeveloperApiTier(
  merchantId: string,
  subRowId: string,
  tier: PaidDeveloperTier,
  patch: Record<string, unknown> = {},
) {
  await admin.from('merchant_developer_subscriptions').update({
    status: 'active',
    ...patch,
  }).eq('id', subRowId);
  await admin.rpc('apply_merchant_developer_tier', {
    p_merchant_id: merchantId,
    p_tier: tier,
  });
}

async function initDeveloperApiSubscription(body: Record<string, unknown>, req: Request) {
  const who = await requireMerchant(req);
  if (!who) return json({ status: false, message: 'Sign in as an approved merchant.' }, 401);

  const tierRaw = String(body.tier ?? '').toLowerCase();
  if (!isPaidDeveloperTier(tierRaw)) {
    return json({ status: false, message: 'tier must be developer or growth.' }, 400);
  }
  const tier = tierRaw as PaidDeveloperTier;

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, email')
    .eq('id', who.merchant.id)
    .maybeSingle();
  if (!merchant) return json({ status: false, message: 'Merchant not found.' }, 404);

  const { data: settings } = await admin.rpc('get_merchant_developer_summary', {
    p_merchant_id: merchant.id,
  });
  const currentTier = String((settings as Record<string, unknown>)?.tier ?? 'free');
  const subStatus = String((settings as Record<string, unknown>)?.subscription_status ?? 'none');
  if (subStatus === 'active' && currentTier === tier) {
    return json({ status: false, message: `${tier} plan is already active.` }, 400);
  }
  if (subStatus === 'active' && currentTier === 'growth' && tier === 'developer') {
    return json({ status: false, message: 'Contact support to downgrade from Growth.' }, 400);
  }

  const idempotencyKey = ensureIdempotencyKey(
    readIdempotencyKey(req, body) || `dev_api_sub:${merchant.id}:${tier}`,
  );
  const resumed = await tryResumeCompletedRequest(admin, merchant.id, idempotencyKey, 'subscription', {
    tier,
    product: 'developer_api',
  });
  if (resumed.hit) {
    return json({ status: true, idempotent: true, retry_count: resumed.retryCount, ...resumed.payload });
  }

  const fee = developerTierAmountZar(tier);
  const currency = 'ZAR';
  const planCode = await getOrCreateDeveloperApiPlan(merchant.id, tier, fee, currency);
  const reference = `rfd_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  const { data: row, error: rowErr } = await admin.from('merchant_developer_subscriptions').insert({
    merchant_id: merchant.id,
    tier,
    amount: fee,
    currency,
    status: 'pending',
    paystack_plan_code: planCode,
    paystack_reference: reference,
    meta: { checkout_started_at: new Date().toISOString() },
  }).select('*').single();

  if (rowErr || !row) {
    return json({ status: false, message: rowErr?.message || 'Could not save subscription' }, 500);
  }

  const ps = await initializeCheckout({
    email: merchant.email,
    plan: planCode,
    reference,
    currency,
    callback_url: `${APP_URL}?developer_api=success`,
    metadata: {
      purchase_type: 'developer_api_subscription',
      merchant_id: merchant.id,
      subscription_row_id: row.id,
      developer_tier: tier,
      monthly_fee: fee,
    },
  });

  if (!ps?.status) {
    await admin.from('merchant_developer_subscriptions').update({ status: 'failed' }).eq('id', row.id);
    return json({ status: false, message: ps?.message || 'Could not start subscription checkout' }, 502);
  }

  const payload = {
    reference,
    amount: fee,
    currency,
    tier,
    plan_code: planCode,
    subscription_row_id: row.id,
    authorization_url: ps.data?.authorization_url,
    access_code: ps.data?.access_code,
  };

  await completePaymentRequest(admin, {
    merchantId: merchant.id,
    idempotencyKey,
    requestType: 'subscription',
    status: 'completed',
    transactionReference: reference,
    responsePayload: payload,
  });

  return json({ status: true, ...payload });
}

async function cancelDeveloperApiSubscription(req: Request) {
  const who = await requireMerchant(req);
  if (!who) return json({ status: false, message: 'Sign in as an approved merchant.' }, 403);

  const { data: sub } = await admin
    .from('merchant_developer_subscriptions')
    .select('id, tier, status, paystack_subscription_code')
    .eq('merchant_id', who.merchant.id)
    .in('status', ['active', 'past_due'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!sub?.paystack_subscription_code) {
    return json({ status: false, message: 'No active Developer API subscription to cancel.' }, 400);
  }

  const ps = await disablePaystackSubscription(secret(), sub.paystack_subscription_code);
  if (!ps?.status) {
    return json({ status: false, message: ps?.message || 'Could not cancel subscription.' }, 502);
  }

  await admin.from('merchant_developer_subscriptions').update({
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
  }).eq('id', sub.id);

  await admin.rpc('downgrade_merchant_developer_to_free', { p_merchant_id: who.merchant.id });

  return json({
    status: true,
    message: 'API plan cancelled. Access continues until the current billing period ends.',
  });
}

async function getPaymentDisputeUploadUrl(body: Record<string, unknown>, req: Request) {
  const auth = await requireMerchant(req);
  if (!auth) return json({ status: false, message: 'Sign in as an approved merchant.' }, 403);

  const disputeId = String(body.dispute_id ?? '');
  const extension = String(body.extension ?? 'pdf').replace(/^\./, '').toLowerCase() || 'pdf';
  if (!disputeId) return json({ status: false, message: 'dispute_id is required.' }, 400);

  const { data: row } = await admin
    .from('payment_disputes')
    .select('id, merchant_id, paystack_dispute_id, status')
    .eq('id', disputeId)
    .maybeSingle();

  if (!row || row.merchant_id !== auth.merchant.id) {
    return json({ status: false, message: 'Dispute not found.' }, 404);
  }
  if (row.status === 'resolved') {
    return json({ status: false, message: 'This dispute is already resolved.' }, 400);
  }

  const ps = await getPaystackDisputeUploadUrl(secret(), row.paystack_dispute_id, extension);
  if (!ps.ok) {
    return json({ status: false, message: ps.message || 'Could not get upload URL.' }, 502);
  }

  const uploadData = (ps.data ?? {}) as Record<string, unknown>;
  return json({
    status: true,
    upload_url: uploadData.upload_url ?? uploadData.url,
    filename: uploadData.filename ?? uploadData.file_name,
  });
}

async function resolvePaymentDispute(body: Record<string, unknown>, req: Request) {
  const auth = await requireMerchant(req);
  if (!auth) return json({ status: false, message: 'Sign in as an approved merchant.' }, 403);

  const disputeId = String(body.dispute_id ?? '');
  const resolution = String(body.resolution ?? '') === 'merchant-accepted' ? 'merchant-accepted' : 'declined';
  const message = String(body.message ?? '').trim();
  const uploadedFilename = String(body.uploaded_filename ?? '').trim() || undefined;

  if (!disputeId || !message) {
    return json({ status: false, message: 'dispute_id and message are required.' }, 400);
  }

  const { data: row } = await admin
    .from('payment_disputes')
    .select('id, merchant_id, paystack_dispute_id, amount, currency, status')
    .eq('id', disputeId)
    .maybeSingle();

  if (!row || row.merchant_id !== auth.merchant.id) {
    return json({ status: false, message: 'Dispute not found.' }, 404);
  }
  if (row.status === 'resolved') {
    return json({ status: false, message: 'This dispute is already resolved.' }, 400);
  }

  const payload: Record<string, string> = { message, resolution };
  if (uploadedFilename) payload.uploaded_filename = uploadedFilename;
  if (resolution === 'merchant-accepted') {
    const refundMajor = Number(body.refund_amount ?? row.amount ?? 0);
    if (refundMajor > 0) {
      payload.refund_amount = String(Math.round(refundMajor * 100));
    }
  }

  const ps = await resolvePaystackDispute(secret(), row.paystack_dispute_id, payload as {
    message: string;
    resolution: 'merchant-accepted' | 'declined';
    refund_amount?: string;
    uploaded_filename?: string;
  });
  if (!ps.ok) {
    return json({ status: false, message: ps.message || 'Paystack could not resolve dispute.' }, 502);
  }

  await admin.from('payment_disputes').update({
    status: 'resolved',
    resolution: resolution === 'merchant-accepted' ? 'merchant-accepted' : 'declined',
    resolved_at: new Date().toISOString(),
    meta: {
      merchant_response: message,
      resolved_via: 'redface-pay',
    },
  }).eq('id', row.id);

  return json({
    status: true,
    message: resolution === 'merchant-accepted'
      ? 'Dispute accepted. Paystack will process the refund.'
      : 'Dispute contested. Paystack will review your evidence.',
  });
}

async function initStudioSubscription(body: Record<string, unknown>, req: Request) {
  const who = await requireUser(req);
  if (!who) return json({ status: false, message: 'Sign in to subscribe to RedFace Studio.' }, 401);

  const planId = normalizeStudioPlanId(String(body.plan_id ?? ''));
  if (!planId) {
    return json({ status: false, message: 'plan_id must be starter or pro.' }, 400);
  }

  const interval = body.interval === 'yearly' ? 'yearly' : 'monthly';
  const studioBase = Deno.env.get('STUDIO_APP_URL')?.replace(/\/$/, '');
  const callbackUrl = String(body.callback_url ?? '').trim()
    || (studioBase ? `${studioBase}/billing/callback` : 'https://redfacestudio.com/billing/callback');
  const email = String(body.email ?? who.email).trim().toLowerCase();
  if (!email) return json({ status: false, message: 'email is required' }, 400);

  let idempotencyKey = String(body.idempotency_key ?? '').trim();
  if (!idempotencyKey) idempotencyKey = `studio_${crypto.randomUUID()}`;

  const amountMajor = studioAmountMajor(planId, interval);
  if (amountMajor == null) {
    return json({ status: false, message: 'Unknown plan or interval.' }, 400);
  }

  const { data: existingRef } = await admin.rpc('get_payment_reference_by_idempotency', {
    p_key: idempotencyKey,
  });
  if (existingRef) {
    const { data: acct } = await admin
      .from('billing_accounts')
      .select('status, metadata')
      .eq('user_id', who.userId)
      .maybeSingle();
    const authUrl = (acct?.metadata as Record<string, unknown> | undefined)?.authorization_url;
    if (acct?.status === 'pending' && typeof authUrl === 'string' && authUrl) {
      return json({
        status: true,
        reference: existingRef,
        authorization_url: authUrl,
        access_code: (acct.metadata as Record<string, unknown>)?.access_code ?? null,
        amount: amountMajor,
        currency: 'ZAR',
        reused: true,
      });
    }
  }

  const reference = `rfs_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const planCode = studioPaystackPlanCode(planId, interval);
  const amountSub = toSubunits(amountMajor);
  const clientMeta =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? { ...(body.metadata as Record<string, unknown>) }
      : {};

  const metadata: Record<string, unknown> = {
    ...clientMeta,
    app: 'studio',
    ecosystem_app: 'studio',
    ecosystem_from: 'studio',
    purchase_type: 'studio_subscription',
    internalPlanId: planId,
    internal_plan_id: planId,
    interval,
    user_id: who.userId,
    userId: who.userId,
    idempotency_key: idempotencyKey,
  };

  const payload: Record<string, unknown> = {
    email,
    amount: amountSub,
    currency: 'ZAR',
    reference,
    callback_url: callbackUrl,
    metadata,
  };
  if (planCode) payload.plan = planCode;

  const { error: upsertErr } = await admin.rpc('upsert_billing_account', {
    p_user_id: who.userId,
    p_email: email,
    p_plan_id: planId,
    p_interval: interval,
    p_status: 'pending',
    p_customer_code: null,
    p_subscription_code: null,
    p_last_reference: reference,
    p_next_payment_at: null,
    p_metadata: { checkout_started_at: new Date().toISOString(), source: 'redface-pay' },
  });
  if (upsertErr) {
    return json({ status: false, message: upsertErr.message || 'Could not save billing row' }, 500);
  }

  const ps = await initializeCheckout(payload);
  if (!ps?.status) {
    await admin.rpc('upsert_billing_account', {
      p_user_id: who.userId,
      p_email: email,
      p_plan_id: 'free',
      p_interval: interval,
      p_status: 'free',
      p_customer_code: null,
      p_subscription_code: null,
      p_last_reference: reference,
      p_next_payment_at: null,
      p_metadata: { checkout_failed_at: new Date().toISOString(), paystack_error: ps?.message },
    });
    return json({ status: false, message: ps?.message || 'Could not start checkout' }, 502);
  }

  const authorizationUrl = ps.data?.authorization_url as string | undefined;
  const accessCode = ps.data?.access_code as string | undefined;
  await admin.rpc('upsert_billing_account', {
    p_user_id: who.userId,
    p_email: email,
    p_plan_id: planId,
    p_interval: interval,
    p_status: 'pending',
    p_customer_code: null,
    p_subscription_code: null,
    p_last_reference: reference,
    p_next_payment_at: null,
    p_metadata: {
      checkout_started_at: new Date().toISOString(),
      authorization_url: authorizationUrl ?? null,
      access_code: accessCode ?? null,
      source: 'redface-pay',
    },
  });

  await appendPlatformPaymentEvent(admin, {
    eventType: 'payment.created',
    reference,
    idempotencyKey,
    app: 'studio',
    userId: who.userId,
    amount: amountMajor,
    currency: 'ZAR',
    payload: { plan_id: planId, interval, source: 'init_studio_subscription' },
  });

  return json({
    status: true,
    reference,
    amount: amountMajor,
    currency: 'ZAR',
    plan_code: planCode,
    authorization_url: authorizationUrl,
    access_code: accessCode,
  });
}

/** Studio callback — verify Paystack ref and sync billing_accounts + ledger (webhook remains authoritative). */
async function confirmStudioSubscription(body: Record<string, unknown>, req: Request) {
  const who = await requireUser(req);
  if (!who) return json({ status: false, message: 'Sign in to confirm your subscription.' }, 401);

  const reference = String(body.reference ?? '').trim();
  if (!reference) return json({ status: false, message: 'reference is required' }, 400);

  const { data: acct } = await admin
    .from('billing_accounts')
    .select('plan_id, interval, status, last_reference, paystack_customer_code, paystack_subscription_code, next_payment_at')
    .eq('user_id', who.userId)
    .maybeSingle();

  if (
    acct?.status === 'active'
    && acct.plan_id
    && acct.plan_id !== 'free'
    && (!acct.last_reference || acct.last_reference === reference)
  ) {
    return json({
      status: true,
      billing_status: 'success',
      reference,
      plan_id: acct.plan_id,
      interval: acct.interval ?? 'monthly',
      customer_code: acct.paystack_customer_code,
      subscription_code: acct.paystack_subscription_code,
      next_payment_at: acct.next_payment_at,
      idempotent: true,
    });
  }

  const verify = await verifyPaystackTransaction(reference);
  const psData = (verify?.data ?? {}) as Record<string, unknown>;
  const psStatus = String(psData.status ?? '');
  const meta = (psData.metadata ?? {}) as Record<string, unknown>;
  const metaUserId = String(meta.user_id ?? meta.userId ?? '').trim();

  if (metaUserId && metaUserId !== who.userId) {
    return json({ status: false, message: 'This payment reference belongs to a different account.' }, 403);
  }

  if (!verify?.status || psStatus === 'failed' || psStatus === 'abandoned') {
    return json({
      status: false,
      billing_status: psStatus || 'failed',
      message: String(verify?.message ?? 'Payment was not successful. You can try again from pricing.'),
    }, 400);
  }

  if (psStatus === 'pending') {
    return json({
      status: false,
      billing_status: 'pending',
      message: 'Payment is still processing with your bank. We will activate your plan automatically once confirmed.',
    }, 400);
  }

  if (!isStudioPaystackMetadata(meta)) {
    return json({ status: false, message: 'This reference is not a RedFace Studio subscription.' }, 400);
  }

  await applyStudioBillingWebhook(admin, 'charge.success', {
    ...psData,
    reference,
    metadata: meta,
  });

  await appendPlatformPaymentEvent(admin, {
    eventType: 'payment.confirmed',
    reference,
    idempotencyKey: String(meta.idempotency_key ?? '').trim() || null,
    app: 'studio',
    userId: who.userId,
    amount: Number(psData.amount ?? 0) / 100,
    currency: String(psData.currency ?? 'ZAR'),
    payload: { source: 'confirm_studio_subscription', plan_id: meta.internal_plan_id ?? meta.internalPlanId },
  });

  const { data: updated } = await admin
    .from('billing_accounts')
    .select('plan_id, interval, status, paystack_customer_code, paystack_subscription_code, next_payment_at')
    .eq('user_id', who.userId)
    .maybeSingle();

  const customer = (psData.customer ?? {}) as Record<string, unknown>;
  const subscription = (psData.subscription ?? {}) as Record<string, unknown>;
  const resolvedPlanId =
    normalizeStudioPlanId(String(meta.internal_plan_id ?? meta.internalPlanId ?? updated?.plan_id ?? ''))
    ?? (updated?.plan_id && updated.plan_id !== 'free' ? String(updated.plan_id) : 'starter');

  return json({
    status: true,
    billing_status: 'success',
    reference,
    plan_id: resolvedPlanId,
    interval: updated?.interval ?? (meta.interval === 'yearly' ? 'yearly' : 'monthly'),
    customer_code: updated?.paystack_customer_code ?? customer.customer_code ?? customer.code ?? null,
    subscription_code: updated?.paystack_subscription_code
      ?? subscription.subscription_code
      ?? subscription.code
      ?? null,
    next_payment_at: updated?.next_payment_at ?? psData.next_payment_date ?? null,
    verified: true,
  });
}

function sponsoredListingPriceForDays(days: number): number {
  return sponsoredListingPrice(days);
}

async function initSponsoredListing(body: Record<string, unknown>, req: Request) {
  const who = await requireMerchant(req);
  if (!who) return json({ status: false, message: 'Sign in as an approved merchant.' }, 401);

  const productId = String(body.product_id ?? '').trim();
  const durationDays = normalizeSponsoredDays(Number(body.duration_days || 7));
  if (!productId) return json({ status: false, message: 'product_id is required' }, 400);

  const { data: product, error: productErr } = await admin
    .from('products')
    .select('id, name, merchant_id, active')
    .eq('id', productId)
    .eq('merchant_id', who.merchant.id)
    .maybeSingle();
  if (productErr) return json({ status: false, message: productErr.message }, 500);
  if (!product || !product.active) return json({ status: false, message: 'Active product not found' }, 404);

  const { data: active } = await admin
    .from('merchant_sponsored_listings')
    .select('id')
    .eq('product_id', productId)
    .eq('status', 'active')
    .gt('ends_at', new Date().toISOString())
    .maybeSingle();
  if (active) {
    return json({ status: false, message: 'This listing already has an active sponsorship. Wait until it expires or choose another product.' }, 400);
  }

  const listPrice = sponsoredListingPriceForDays(durationDays);
  const planCode = sponsoredPlanCode(durationDays);
  const currency = 'ZAR';
  const reference = `rfs_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  const { data: merchantRow } = await admin
    .from('merchants')
    .select('referral_credit_zar')
    .eq('id', who.merchant.id)
    .maybeSingle();
  const referralBalance = Math.max(0, Number(merchantRow?.referral_credit_zar ?? 0));
  const referralCreditApplied = Math.min(referralBalance, listPrice);
  const amountDue = Math.max(0, listPrice - referralCreditApplied);

  const { data: row, error: rowErr } = await admin.from('merchant_sponsored_listings').insert({
    merchant_id: who.merchant.id,
    product_id: productId,
    status: 'pending_payment',
    duration_days: durationDays,
    currency,
    paystack_reference: reference,
    paystack_plan_code: planCode,
    priority: 100 + durationDays,
    meta: {
      product_name: product.name,
      list_price: listPrice,
      referral_credit_applied: referralCreditApplied,
    },
  }).select('id').single();

  if (rowErr || !row) {
    return json({ status: false, message: rowErr?.message || 'Could not create sponsorship' }, 500);
  }

  const metadata = {
    purchase_type: 'sponsored_listing',
    merchant_id: who.merchant.id,
    product_id: productId,
    sponsored_listing_id: row.id,
    duration_days: durationDays,
    product_name: product.name,
    paystack_plan_code: planCode,
    list_price: listPrice,
    referral_credit_applied: referralCreditApplied,
  };

  if (amountDue <= 0) {
    const { data: consumed } = await admin.rpc('consume_referral_credit', {
      p_merchant_id: who.merchant.id,
      p_amount: referralCreditApplied,
      p_reference: reference,
    });
    const creditUsed = Number(consumed ?? 0);
    if (creditUsed < referralCreditApplied) {
      await admin.from('merchant_sponsored_listings').update({ status: 'cancelled' }).eq('id', row.id);
      return json({ status: false, message: 'Could not apply referral credit. Try again.' }, 409);
    }
    const creditRef = `rfc_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const { activateSponsoredListingRow } = await import('../_shared/sponsoredActivate.ts');
    await activateSponsoredListingRow(
      admin,
      row.id,
      creditRef,
      listPrice,
      currency,
      durationDays,
      null,
      { paid_with_referral_credit: true, referral_credit_applied: creditUsed },
    );
    return json({
      status: true,
      paid_with_credit: true,
      reference: creditRef,
      amount: listPrice,
      amount_due: 0,
      referral_credit_applied: creditUsed,
      currency,
      duration_days: durationDays,
      plan_code: planCode,
      sponsored_listing_id: row.id,
    });
  }

  const paystackBody: Record<string, unknown> = {
    email: who.email,
    reference,
    currency,
    callback_url: `${APP_URL}?view=portal&portalTab=grow&sponsor=success`,
    metadata,
  };
  if (referralCreditApplied > 0) {
    paystackBody.amount = Math.round(amountDue * 100);
  } else {
    paystackBody.plan = planCode;
  }

  const ps = await initializeCheckout(paystackBody);

  if (!ps?.status) {
    await admin.from('merchant_sponsored_listings').update({ status: 'cancelled' }).eq('id', row.id);
    return json({ status: false, message: ps?.message || 'Could not start checkout' }, 502);
  }

  return json({
    status: true,
    reference,
    amount: listPrice,
    amount_due: amountDue,
    referral_credit_applied: referralCreditApplied,
    currency,
    duration_days: durationDays,
    plan_code: planCode,
    sponsored_listing_id: row.id,
    authorization_url: ps.data?.authorization_url,
    access_code: ps.data?.access_code,
  });
}

// Verify with Paystack before marking success — webhook remains authoritative for
// side effects, but this blocks unauthenticated fake confirmations from the client.
async function confirmPayment(body: Record<string, unknown>) {
  const reference = String(body.reference ?? '');
  if (!reference) return json({ status: false, message: 'reference is required' }, 400);

  const { data: txn } = await admin
    .from('transactions')
    .select('id, merchant_id, amount, card_amount, currency, buyer_email, buyer_phone, status, store_credit_id, store_credit_applied')
    .eq('reference', reference)
    .maybeSingle();

  if (!txn) return json({ status: false, message: 'Transaction not found' }, 404);

  if (txn.status === 'success') {
    const { completeBuyerPaymentIntents } = await import('../_shared/buyerPaymentIntents.ts');
    await completeBuyerPaymentIntents(admin, { reference });
    return json({ status: true, reference, idempotent: true });
  }

  const cardAmount = Number(txn.card_amount ?? txn.amount);
  const storeCreditApplied = Number(txn.store_credit_applied ?? 0);

  if (cardAmount <= 0 && storeCreditApplied > 0) {
    return json({ status: false, message: 'Payment is still processing' }, 400);
  }

  const verify = await verifyPaystackTransaction(reference);
  const psData = verify?.data as Record<string, unknown> | undefined;
  const psStatus = String(psData?.status ?? '');

  if (!verify?.status || psStatus !== 'success') {
    if (psStatus === 'failed' || psStatus === 'abandoned') {
      await admin.from('transactions').update({ status: 'failed' }).eq('reference', reference);
      await markSessionFailed(admin, reference);
    }
    return json({
      status: false,
      message: 'Payment not verified with Paystack yet. If you completed checkout, wait a moment and refresh.',
    }, 400);
  }

  const paidSub = Number(psData?.amount ?? 0);
  const expectedSub = toSubunits(cardAmount);
  if (paidSub > 0 && paidSub !== expectedSub) {
    console.error('confirm_payment amount mismatch', { reference, paidSub, expectedSub, cardAmount });
    return json({ status: false, message: 'Payment amount mismatch. Contact support.' }, 400);
  }

  await admin.from('transactions').update({ status: 'success' }).eq('reference', reference);

  if (storeCreditApplied > 0 && txn.store_credit_id) {
    const redeem = await redeemStoreCreditIfNeeded(admin, {
      creditId: String(txn.store_credit_id),
      merchantId: String(txn.merchant_id),
      buyerEmail: String(txn.buyer_email ?? ''),
      amount: storeCreditApplied,
      reference,
      transactionId: txn.id,
    });
    if (!redeem.ok) {
      console.error('confirm_payment store credit redeem failed', redeem.message);
    }
  }

  await markSessionPaid(admin, reference, txn.id);

  const { completeBuyerPaymentIntents } = await import('../_shared/buyerPaymentIntents.ts');
  await completeBuyerPaymentIntents(admin, { reference });

  const meta = (psData?.metadata as Record<string, unknown> | undefined) ?? {};
  const isMarketplaceCart = String(meta.object_type ?? '') === 'marketplace_cart'
    || meta.marketplace_checkout === true;

  let orderNumber: string | null = null;
  let orderNumbers: string[] = [];

  if (isMarketplaceCart && txn.buyer_email) {
    const fanOut = await fanOutMarketplaceCheckoutSuccess(admin, {
      reference,
      buyerEmail: String(txn.buyer_email),
      buyerPhone: (txn.buyer_phone as string) ?? null,
      currency: (txn.currency as string) ?? 'ZAR',
      parentTransactionId: txn.id,
    });
    if (fanOut.ok && fanOut.orderNumbers?.length) {
      orderNumbers = fanOut.orderNumbers;
      orderNumber = fanOut.orderNumbers[0] ?? null;
    }
  } else {
    if (txn.merchant_id && txn.buyer_email) {
      const cartItemsJson = (meta.cart_items_json as string) ?? null;
      const order = await createOrderFromPayment(admin, {
        reference,
        merchantId: String(txn.merchant_id),
        amount: Number(txn.amount),
        currency: (txn.currency as string) ?? null,
        buyerEmail: String(txn.buyer_email),
        buyerPhone: (txn.buyer_phone as string) ?? null,
        productId: (meta.product_id as string) ?? null,
        label: (meta.label as string) ?? null,
        purchaseType: String(meta.object_type ?? '') === 'cart' || cartItemsJson ? 'cart' : undefined,
        cartItemsJson,
      });
      if (order.ok && order.order_number) orderNumber = order.order_number;
    }
  }

  return json({
    status: true,
    reference,
    order_number: orderNumber,
    order_numbers: orderNumbers.length ? orderNumbers : undefined,
    verified: true,
  });
}

// Admin approval: create a Paystack subaccount from the merchant's verified bank
// details, mark them approved, and mint an NFC tag. Returns the subaccount code
// and tag code the AdminPanel surfaces in its toast.
async function createSubaccount(body: Record<string, unknown>) {
  const merchantId = String(body.merchant_id ?? '');
  if (!merchantId) return json({ status: false, message: 'merchant_id is required' }, 400);
  const actorEmail = String(body.actor_email ?? '').trim() || null;
  const decisionReason = String(body.decision_reason ?? '').trim();
  const decisionNotes = String(body.decision_notes ?? '').trim();
  const manualCode = String(body.subaccount_code ?? '').trim();

  const result = await provisionMerchantPayouts(admin, paystackPost, {
    merchantId,
    actorEmail,
    decisionReason: decisionReason || 'Approved after KYC, bank and business offering review',
    decisionNotes: decisionNotes || null,
    manualSubaccountCode: manualCode || undefined,
    platformFeePercent: PLATFORM_FEE_PERCENT,
    sendWelcomeEmail: sendMerchantWelcomeEmail,
  });

  if (!result.ok) {
    return json({ status: false, message: result.message || 'Could not provision payouts' }, result.message?.includes('Paystack') ? 502 : 400);
  }

  return json({
    status: true,
    subaccount: result.subaccount,
    tag_code: result.tag_code,
    already_approved: result.already_approved ?? false,
  });
}

// Admin: enable/disable a merchant and notify them by email. Disabling pauses
// their payment links/tags; enabling restores them. Best-effort email (needs a
// verified Resend sender) — the status change always applies regardless.
async function setMerchantStatus(body: Record<string, unknown>) {
  const merchantId = String(body.merchant_id ?? '');
  const status = String(body.status ?? '');
  const reason = String(body.reason ?? '').trim();
  const actorEmail = String(body.actor_email ?? '').trim() || null;
  const decisionNotes = String(body.decision_notes ?? '').trim();
  if (!merchantId || (status !== 'disabled' && status !== 'approved')) {
    return json({ status: false, message: 'merchant_id and a valid status (disabled|approved) are required' }, 400);
  }

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, business_name, email, legal_status, permit_number, permit_expiry, offering_type, primary_products, expected_monthly_volume, sells_restricted_goods, risk_level, account_verified')
    .eq('id', merchantId)
    .maybeSingle();
  if (!merchant) return json({ status: false, message: 'Merchant not found' }, 404);

  await admin.from('merchants').update({ status }).eq('id', merchantId);
  await admin.from('admin_actions').insert({
    action_type: status === 'disabled' ? 'disable_merchant' : 'enable_merchant',
    merchant_id: merchantId,
    actor_email: actorEmail,
    decision_reason: reason || (status === 'disabled' ? 'Account disabled by admin' : 'Account re-enabled by admin'),
    decision_notes: decisionNotes || null,
    compliance_snapshot: {
      legal_status: merchant.legal_status,
      permit_number: merchant.permit_number,
      permit_expiry: merchant.permit_expiry,
      offering_type: merchant.offering_type,
      primary_products: merchant.primary_products,
      expected_monthly_volume: merchant.expected_monthly_volume,
      sells_restricted_goods: merchant.sells_restricted_goods,
      risk_level: merchant.risk_level,
      account_verified: merchant.account_verified,
      next_status: status,
    },
  });

  let emailed = false;
  if (merchant.email) {
    if (status === 'disabled') {
      emailed = await sendEmail(
        'Your RedFace Pay account has been disabled',
        `<h2>Account disabled</h2>
         <p>Hi ${merchant.business_name},</p>
         <p>Your RedFace Pay account has been <b>temporarily disabled</b>. While disabled, your
         payment links, QR codes and NFC tags will not accept new payments.</p>
         ${reason ? `<p><b>Reason:</b> ${reason}</p>` : ''}
         <p>If you think this is a mistake or want to resolve it, please contact us at
         <a href="mailto:support@redfacepay.co.za">support@redfacepay.co.za</a>.</p>`,
        merchant.email,
      );
    } else {
      emailed = await sendEmail(
        'Your RedFace Pay account is active again',
        `<h2>Account re-enabled</h2>
         <p>Hi ${merchant.business_name},</p>
         <p>Good news — your RedFace Pay account has been <b>re-enabled</b> and can accept payments
         again. Your existing payment links, QR codes and NFC tags work as before.</p>
         <p>Sign in to your portal: <a href="${APP_URL}">${APP_URL}</a></p>`,
        merchant.email,
      );
    }
  }

  return json({ status: true, merchant_status: status, emailed });
}

// Send an email via Resend. Best-effort: returns false (and logs) on any issue
// so notification failures never block the rest of the workflow.
async function sendEmail(subject: string, html: string, to: string = NOTIFY_TO): Promise<boolean> {
  return sendCampaignEmail(to, subject, html, NOTIFY_FROM);
}

async function sendCampaignEmail(
  to: string,
  subject: string,
  html: string,
  from: string = NOTIFY_FROM,
  replyTo?: string,
): Promise<boolean> {
  if (!RESEND_API_KEY || !to) return false;
  try {
    const payload: Record<string, unknown> = { from, to: [to], subject, html };
    if (replyTo) payload.reply_to = replyTo;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error('resend email failed', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('resend email error', err);
    return false;
  }
}

type StaffRole = 'manager' | 'cashier';

function staffPermissionsForRole(role: StaffRole): Record<string, boolean> {
  if (role === 'manager') {
    return {
      payments: true, inventory: true, finance: true, business: true,
      analytics: true, grow: true, website: true, ai: true, staff_admin: false,
    };
  }
  return {
    payments: true, inventory: false, finance: false, business: false,
    analytics: false, grow: false, website: false, ai: false, staff_admin: false,
  };
}

function staffInviteEmailHtml(opts: {
  businessName: string;
  inviterEmail: string;
  inviteeName: string | null;
  role: string;
  inviteeEmail: string;
}): string {
  const greet = opts.inviteeName || opts.inviteeEmail.split('@')[0];
  const portalUrl = `${APP_URL}/?view=portal`;
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
      <h2 style="color:#FF4B4B;margin-bottom:8px;">You're invited to ${opts.businessName}</h2>
      <p>Hi ${greet},</p>
      <p>You've been invited as <strong>${opts.role}</strong> on RedFace Pay for <strong>${opts.businessName}</strong>.</p>
      <p>Sign in with <strong>${opts.inviteeEmail}</strong>. Use that exact email for your RedFace account — create one first if you're new, then open the merchant portal.</p>
      <p style="margin:24px 0;">
        <a href="${portalUrl}" style="background:#FF4B4B;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Open merchant portal</a>
      </p>
      <p style="font-size:13px;color:#666;">Invited by ${opts.inviterEmail}. Need help? Contact ${PLATFORM_INFO_EMAIL}.</p>
    </div>
  `.trim();
}

async function sendStaffInviteEmail(
  merchant: { business_name?: string | null; email?: string | null },
  inviterEmail: string,
  inviteeEmail: string,
  inviteeName: string | null,
  role: string,
): Promise<boolean> {
  const businessName = merchant.business_name || 'a RedFace merchant';
  const html = staffInviteEmailHtml({
    businessName,
    inviterEmail,
    inviteeName,
    role,
    inviteeEmail,
  });
  return sendCampaignEmail(
    inviteeEmail,
    `You're invited to ${businessName} on RedFace Pay`,
    html,
    NOTIFY_FROM,
    merchant.email || inviterEmail,
  );
}

async function inviteStaff(body: Record<string, unknown>, req: Request) {
  const who = await requireMerchant(req);
  if (!who) return json({ status: false, message: 'Sign in as the approved merchant owner to invite staff.' }, 401);

  const inviteEmail = String(body.email ?? '').trim().toLowerCase();
  const displayName = String(body.display_name ?? '').trim() || null;
  const roleRaw = String(body.role ?? 'cashier').toLowerCase();
  if (!inviteEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail)) {
    return json({ status: false, message: 'A valid email is required.' }, 400);
  }
  if (roleRaw !== 'manager' && roleRaw !== 'cashier') {
    return json({ status: false, message: 'Role must be manager or cashier.' }, 400);
  }
  if (inviteEmail === who.email) {
    return json({ status: false, message: 'You cannot invite yourself.' }, 400);
  }

  const role = roleRaw as StaffRole;
  const permissions = staffPermissionsForRole(role);

  const { data: existing } = await admin
    .from('merchant_staff')
    .select('id')
    .eq('merchant_id', who.merchant.id)
    .ilike('email', inviteEmail)
    .maybeSingle();

  let row: Record<string, unknown> | null = null;
  let dbError: { message?: string } | null = null;

  if (existing?.id) {
    const { data, error } = await admin.from('merchant_staff').update({
      display_name: displayName,
      role,
      permissions,
      status: 'invited',
      invited_at: new Date().toISOString(),
      accepted_at: null,
    }).eq('id', existing.id).select('*').single();
    row = data;
    dbError = error;
  } else {
    const { data, error } = await admin.from('merchant_staff').insert({
      merchant_id: who.merchant.id,
      email: inviteEmail,
      display_name: displayName,
      role,
      status: 'invited',
      permissions,
    }).select('*').single();
    row = data;
    dbError = error;
  }

  if (dbError || !row) {
    return json({ status: false, message: dbError?.message || 'Could not save team invite.' }, 500);
  }

  const emailed = await sendStaffInviteEmail(
    who.merchant,
    who.email,
    inviteEmail,
    displayName,
    role,
  );

  if (!emailed && !RESEND_API_KEY) {
    return json({
      status: true,
      staff: row,
      emailed: false,
      message: 'Invite saved but email is not configured on the server (RESEND_API_KEY). Share the portal link manually.',
    });
  }

  return json({
    status: true,
    staff: row,
    emailed,
    message: emailed
      ? `Invite email sent to ${inviteEmail}.`
      : `Invite saved but the email could not be delivered. Ask them to sign in at ${APP_URL}/?view=portal with ${inviteEmail}.`,
  });
}

async function resendStaffInvite(body: Record<string, unknown>, req: Request) {
  const who = await requireMerchant(req);
  if (!who) return json({ status: false, message: 'Sign in as the approved merchant owner.' }, 401);

  const staffId = String(body.staff_id ?? '').trim();
  if (!staffId) return json({ status: false, message: 'staff_id is required.' }, 400);

  const { data: row, error } = await admin
    .from('merchant_staff')
    .select('*')
    .eq('id', staffId)
    .eq('merchant_id', who.merchant.id)
    .maybeSingle();
  if (error) return json({ status: false, message: error.message }, 500);
  if (!row) return json({ status: false, message: 'Team member not found.' }, 404);
  if (row.status === 'disabled') {
    return json({ status: false, message: 'Re-enable this team member before resending an invite.' }, 400);
  }

  const emailed = await sendStaffInviteEmail(
    who.merchant,
    who.email,
    String(row.email).toLowerCase(),
    row.display_name as string | null,
    String(row.role),
  );

  return json({
    status: true,
    emailed,
    message: emailed
      ? `Invite email resent to ${row.email}.`
      : 'Could not send email. Check RESEND_API_KEY or share the portal link manually.',
  });
}

type CampaignCustomer = {
  id: string;
  email: string | null;
  display_name: string | null;
  purchase_count: number;
  first_purchase_at: string | null;
  last_purchase_at: string | null;
};

function filterCampaignAudience(customers: CampaignCustomer[], segment: string): CampaignCustomer[] {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  return customers.filter((c) => {
    const email = String(c.email ?? '').trim();
    if (!email) return false;
    if (segment === 'repeat') return Number(c.purchase_count) >= 2;
    if (segment === 'lapsed') {
      if (!c.last_purchase_at) return false;
      return now - new Date(c.last_purchase_at).getTime() > 60 * day;
    }
    if (segment === 'new') {
      if (!c.first_purchase_at) return false;
      return now - new Date(c.first_purchase_at).getTime() <= 30 * day;
    }
    return true;
  });
}

async function loadCampaignAudience(merchantId: string, segment: string): Promise<CampaignCustomer[]> {
  const { data, error } = await admin
    .from('merchant_customers')
    .select('id, email, display_name, purchase_count, first_purchase_at, last_purchase_at')
    .eq('merchant_id', merchantId);
  if (error) throw new Error(error.message);

  const customers = filterCampaignAudience((data as CampaignCustomer[]) || [], segment);
  if (!customers.length) return [];

  const ids = customers.map((c) => c.id);
  const { data: prefs } = await admin
    .from('merchant_customer_preferences')
    .select('customer_id, marketing_email')
    .eq('merchant_id', merchantId)
    .in('customer_id', ids);

  const allowed = new Set(
    (prefs || [])
      .filter((p) => p.marketing_email !== false)
      .map((p) => String(p.customer_id)),
  );
  // Missing preference row → allow (defaults true); explicit false → exclude.
  const prefIds = new Set((prefs || []).map((p) => String(p.customer_id)));
  return customers.filter((c) => !prefIds.has(c.id) || allowed.has(c.id));
}

async function merchantFromAddress(merchantId: string, businessName: string): Promise<string> {
  const { data } = await admin
    .from('merchant_email_aliases')
    .select('email_address')
    .eq('merchant_id', merchantId)
    .eq('status', 'verified')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data?.email_address) return `${businessName} <${data.email_address}>`;
  return NOTIFY_FROM;
}

function campaignEmailHtml(businessName: string, body: string): string {
  const safeBody = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>');
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
      <p style="font-size:14px;color:#666;margin:0 0 16px;">Message from ${businessName} via RedFace Pay</p>
      <div style="font-size:15px;line-height:1.6;">${safeBody}</div>
      <p style="margin-top:24px;font-size:12px;color:#999;">You received this because you paid ${businessName} through RedFace Pay.</p>
    </div>`;
}

async function deliverCampaign(campaignId: string) {
  const { data: campaign, error: campErr } = await admin
    .from('merchant_campaigns')
    .select('*, merchants(business_name, email)')
    .eq('id', campaignId)
    .maybeSingle();
  if (campErr || !campaign) throw new Error(campErr?.message || 'Campaign not found');
  if (campaign.status === 'sent' || campaign.status === 'cancelled') {
    return { status: true, message: 'Campaign already finished', campaign };
  }
  if (campaign.channel !== 'email') {
    throw new Error('Only email campaigns can be sent automatically.');
  }

  const merchant = campaign.merchants as { business_name?: string; email?: string } | null;
  const businessName = merchant?.business_name || 'Your merchant';
  const audience = await loadCampaignAudience(campaign.merchant_id, campaign.segment);
  const from = await merchantFromAddress(campaign.merchant_id, businessName);
  const replyTo = merchant?.email || undefined;
  const html = campaignEmailHtml(businessName, campaign.body);

  await admin.from('merchant_campaigns').update({ status: 'sending', audience_count: audience.length }).eq('id', campaignId);
  await admin.from('merchant_campaign_recipients').delete().eq('campaign_id', campaignId);

  let sent = 0;
  let failed = 0;
  // Delivery goes through platform_notification_outbox (same path as receipts / reviews).
  // `from` / reply-to stay in payload for future worker enrichment; worker uses NOTIFY_FROM today.
  void from;
  void replyTo;
  for (const customer of audience) {
    const email = String(customer.email ?? '').trim();
    const { data: row } = await admin.from('merchant_campaign_recipients').insert({
      campaign_id: campaignId,
      customer_id: customer.id,
      email,
      display_name: customer.display_name,
      status: 'pending',
    }).select('id').single();

    const { data: outboxId, error: enqueueErr } = await admin.rpc('enqueue_platform_notification', {
      p_channel: 'email',
      p_recipient: email,
      p_event_type: 'merchant_campaign',
      p_body: html,
      p_payload: {
        campaign_id: campaignId,
        customer_id: customer.id,
        merchant_name: businessName,
        from_address: from,
        reply_to: replyTo ?? null,
      },
      p_subject: campaign.subject,
      p_merchant_id: campaign.merchant_id,
      p_reference: `campaign:${campaignId}:${email}`,
    });

    if (!enqueueErr && outboxId) {
      sent += 1;
      if (row?.id) {
        await admin.from('merchant_campaign_recipients').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', row.id);
      }
    } else {
      failed += 1;
      if (row?.id) {
        await admin.from('merchant_campaign_recipients').update({
          status: 'failed',
          error: enqueueErr?.message || 'Outbox enqueue failed',
        }).eq('id', row.id);
      }
    }
  }

  const finalStatus = sent > 0 ? 'sent' : 'failed';
  const { data: updated } = await admin.from('merchant_campaigns').update({
    status: finalStatus,
    sent_at: new Date().toISOString(),
    audience_count: audience.length,
    sent_count: sent,
    failed_count: failed,
  }).eq('id', campaignId).select('*').single();

  return { status: true, campaign: updated, sent, failed, audience: audience.length };
}

async function sendCampaign(body: Record<string, unknown>, req: Request) {
  const who = await requireMerchant(req);
  if (!who) return json({ status: false, message: 'Sign in as an approved merchant.' }, 401);

  const campaignId = String(body.campaign_id ?? '');
  if (!campaignId) return json({ status: false, message: 'campaign_id is required' }, 400);

  const { data: campaign } = await admin
    .from('merchant_campaigns')
    .select('id, merchant_id, status, channel')
    .eq('id', campaignId)
    .maybeSingle();
  if (!campaign || campaign.merchant_id !== who.merchant.id) {
    return json({ status: false, message: 'Campaign not found.' }, 404);
  }

  try {
    const result = await deliverCampaign(campaignId);
    return json(result);
  } catch (err) {
    await admin.from('merchant_campaigns').update({ status: 'failed' }).eq('id', campaignId);
    return json({ status: false, message: err instanceof Error ? err.message : 'Send failed' }, 500);
  }
}

async function previewCampaign(body: Record<string, unknown>, req: Request) {
  const who = await requireMerchant(req);
  if (!who) return json({ status: false, message: 'Sign in as an approved merchant.' }, 401);

  const segment = String(body.segment ?? 'all');
  const audience = await loadCampaignAudience(who.merchant.id, segment);
  return json({ status: true, count: audience.length, segment });
}

async function processAbandonedCartRemindersJob(req: Request) {
  const cron = req.headers.get('x-cron-secret') ?? '';
  const cronOk = !!(CRON_SECRET && cron && cron === CRON_SECRET);
  if (!cronOk) {
    const who = await requireAdmin(req);
    if (!who) return json({ status: false, message: 'Not authorized.' }, 403);
  }
  const result = await processAbandonedCartReminders(admin);
  await admin.rpc('expire_sponsored_listings').then(() => {}, () => {});
  return json({ status: true, triggered_by: cronOk ? 'cron' : 'admin', ...result });
}

async function processScheduledCampaigns(req: Request) {
  const cron = req.headers.get('x-cron-secret') ?? '';
  if (!CRON_SECRET || cron !== CRON_SECRET) {
    return json({ status: false, message: 'Not authorized.' }, 403);
  }

  const { data: due } = await admin
    .from('merchant_campaigns')
    .select('id')
    .eq('status', 'scheduled')
    .eq('channel', 'email')
    .lte('scheduled_at', new Date().toISOString())
    .limit(10);

  const results: { id: string; ok: boolean; sent?: number; error?: string }[] = [];
  for (const row of due || []) {
    try {
      const out = await deliverCampaign(row.id);
      results.push({ id: row.id, ok: true, sent: out.sent });
    } catch (err) {
      results.push({ id: row.id, ok: false, error: err instanceof Error ? err.message : 'failed' });
    }
  }
  return json({ status: true, processed: results.length, results });
}

// Notify admins of a new merchant application. Triggered immediately after the
// merchant row is created (client call) AND/OR by a Supabase Database Webhook on
// INSERT — both call this. It is IDEMPOTENT (one notification per merchant via a
// unique index), so duplicate triggers are safe. It NEVER touches how the
// merchant was saved; it only reacts to a row that already exists.
async function authorizeNotifyApplication(req: Request, merchantId: string): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const { data: m } = await admin
    .from('merchants')
    .select('email, created_at, status')
    .eq('id', merchantId)
    .maybeSingle();
  if (!m) return false;

  if (token) {
    const { data: authUser } = await admin.auth.getUser(token);
    const callerEmail = authUser?.user?.email?.toLowerCase();
    if (callerEmail && callerEmail === String(m.email).toLowerCase()) return true;
  }

  // Onboarding may run before email confirmation — allow fresh pending applications.
  if (m.status === 'pending' && m.created_at) {
    const ageMs = Date.now() - new Date(String(m.created_at)).getTime();
    if (ageMs >= 0 && ageMs < 15 * 60 * 1000) return true;
  }
  return false;
}

/** Merchant owner (or admin) may provision their own Paystack subaccount for Tick3t. */
async function authorizeTick3tMerchantProvision(
  req: Request,
  merchantId: string,
): Promise<{ ok: true; actorEmail: string | null } | { ok: false }> {
  const adminEmail = await requireAdmin(req);
  if (adminEmail) return { ok: true, actorEmail: adminEmail };

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false };

  const { data: authUser } = await admin.auth.getUser(token);
  const callerEmail = authUser?.user?.email?.toLowerCase() ?? '';
  const callerId = authUser?.user?.id ?? null;
  if (!callerEmail && !callerId) return { ok: false };

  const { data: m } = await admin
    .from('merchants')
    .select('id, email, auth_user_id')
    .eq('id', merchantId)
    .maybeSingle();
  if (!m) return { ok: false };

  const emailMatch = callerEmail && callerEmail === String(m.email ?? '').toLowerCase();
  const uidMatch = callerId && m.auth_user_id && String(m.auth_user_id) === String(callerId);
  if (!emailMatch && !uidMatch) return { ok: false };

  return { ok: true, actorEmail: callerEmail || null };
}

async function tick3tProvisionSubaccount(body: Record<string, unknown>, req: Request) {
  const merchantId = String(body.merchant_id ?? '').trim();
  if (!merchantId) return json({ status: false, message: 'merchant_id is required' }, 400);

  const authz = await authorizeTick3tMerchantProvision(req, merchantId);
  if (!authz.ok) {
    return json({ status: false, message: 'Not authorized for this merchant.' }, 403);
  }

  const result = await provisionMerchantPayouts(admin, paystackPost, {
    merchantId,
    actorEmail: authz.actorEmail,
    decisionReason: 'Tick3t seller / venue payout provisioning',
    decisionNotes: 'Auto-provisioned after Tick3t signup or bank update',
    platformFeePercent: PLATFORM_FEE_PERCENT,
    sendWelcomeEmail: sendMerchantWelcomeEmail,
  });

  if (!result.ok) {
    return json(
      { status: false, message: result.message || 'Could not provision payouts' },
      result.message?.includes('Paystack') ? 502 : 400,
    );
  }

  return json({
    status: true,
    subaccount: result.subaccount,
    tag_code: result.tag_code,
    already_approved: result.already_approved ?? false,
  });
}

async function notifyApplication(body: Record<string, unknown>) {
  // Accept either a client action ({ merchant_id }) or a DB-webhook payload
  // ({ type, table, record: {...} }).
  const record = (body.record ?? null) as Record<string, unknown> | null;
  const merchantId = String(body.merchant_id ?? record?.id ?? '');
  if (!merchantId) return json({ status: false, message: 'merchant_id is required' }, 400);

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, business_name, email, phone, category, country, status, created_at')
    .eq('id', merchantId)
    .maybeSingle();
  if (!merchant) return json({ status: false, message: 'Merchant not found' }, 404);

  const title = `New merchant application: ${merchant.business_name}`;
  const summary =
    `${merchant.business_name} (${merchant.email}` +
    `${merchant.phone ? ', ' + merchant.phone : ''}) applied` +
    `${merchant.category ? ' · ' + merchant.category : ''}` +
    `${merchant.country ? ' · ' + merchant.country : ''}.`;

  // Idempotent insert: the unique (merchant_id, type) index means a second
  // trigger is ignored instead of creating a duplicate. We detect that and skip
  // re-sending the email/audit.
  const { data: inserted, error: insErr } = await admin
    .from('admin_notifications')
    .insert({ type: 'merchant_application', title, body: summary, merchant_id: merchantId })
    .select('id')
    .maybeSingle();

  // Unique-violation (23505) => already notified for this merchant: no-op.
  if (insErr) {
    if ((insErr as { code?: string }).code === '23505') {
      return json({ status: true, duplicate: true });
    }
    throw insErr;
  }

  // Audit trail.
  await admin.from('admin_actions').insert({
    action_type: 'merchant_applied',
    merchant_id: merchantId,
  });

  // Email the admin inbox (best-effort).
  const html = `<h2>New merchant application</h2>
     <p>${summary}</p>
     <ul>
       <li><b>Business:</b> ${merchant.business_name}</li>
       <li><b>Email:</b> ${merchant.email}</li>
       <li><b>Phone:</b> ${merchant.phone ?? '—'}</li>
       <li><b>Category:</b> ${merchant.category ?? '—'}</li>
       <li><b>Country:</b> ${merchant.country ?? '—'}</li>
       <li><b>Status:</b> ${merchant.status}</li>
     </ul>
     <p>Review and approve in the RedFace Pay Admin Panel: <a href="${APP_URL}">${APP_URL}</a></p>`;
  const emailed = await sendEmail(title, html);
  void notifyBoss({
    subject: title,
    html: bossAlertHtml('merchant_application', {
      Business: String(merchant.business_name),
      Email: String(merchant.email),
      Country: String(merchant.country ?? '—'),
      Status: String(merchant.status),
    }),
  });

  const auto = await tryAutoApproveMerchant(admin, paystackPost, {
    merchantId,
    ...autoApproveDeps(),
  });

  if (auto.approved) {
    await admin.from('admin_notifications').insert({
      type: 'merchant_auto_approved',
      title: `Auto-approved: ${merchant.business_name}`,
      body: `${merchant.business_name} passed bank + business checks and is live for payouts.`,
      merchant_id: merchantId,
    }).then(() => {}, () => {});
  }

  return json({
    status: true,
    notification_id: inserted?.id,
    emailed,
    auto_approved: auto.approved,
    auto_approve_blockers: auto.blockers ?? [],
    subaccount: auto.subaccount ?? null,
  });
}

async function handleBossNotify(body: Record<string, unknown>, req: Request) {
  const event = String(body.event ?? '') as BossEvent;
  const allowed = new Set(['user_signup', 'client_error']);
  if (!allowed.has(event)) {
    return json({ status: false, message: 'Event not allowed' }, 403);
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ status: false, message: 'Unauthorized' }, 401);

  const { data: authData } = await admin.auth.getUser(token);
  const email = authData?.user?.email?.toLowerCase();
  if (!email) return json({ status: false, message: 'Unauthorized' }, 401);

  const detail = (body.detail ?? {}) as Record<string, unknown>;

  if (event === 'user_signup') {
    await notifyBoss({
      subject: `New RedFace account: ${email}`,
      html: bossAlertHtml('user_signup', {
        Email: email,
        Source: String(detail.source ?? 'web'),
      }),
    });
  } else if (event === 'client_error') {
    const msg = String(detail.message ?? 'Unknown error').slice(0, 300);
    await notifyBoss({
      subject: `RedFace client error: ${msg.slice(0, 80)}`,
      html: bossAlertHtml('client_error', {
        Error: msg,
        Path: String(detail.path ?? '—'),
        User: email,
      }),
    });
  }

  return json({ status: true });
}

async function handleSendSignupVerification(body: Record<string, unknown>) {
  const email = String(body.email ?? '').trim();
  const result = await sendSignupVerificationEmail(admin, email);
  return json({ status: result.ok, message: result.message, already_verified: result.alreadyVerified ?? false });
}

async function handleVerifySignupEmail(body: Record<string, unknown>) {
  const token = String(body.token ?? '').trim();
  if (!token) return json({ status: false, message: 'Missing verification token.' }, 400);
  const { data, error } = await admin.rpc('verify_signup_email', { p_token: token });
  if (error) return json({ status: false, message: error.message }, 500);
  if (!data) return json({ status: false, message: 'Invalid or expired verification link.' }, 400);
  return json({ status: true, message: 'Email verified. You can sign in now.' });
}

// Queue a Paystack refund for a pending merchant_refund_requests row.
async function processRefund(body: Record<string, unknown>, req: Request) {
  const requestId = String(body.refund_request_id ?? '').trim();
  if (!requestId) return json({ status: false, message: 'refund_request_id is required' }, 400);

  const { data: refundReq, error: loadErr } = await admin
    .from('merchant_refund_requests')
    .select('id, merchant_id, transaction_id, amount, currency, status, reason, buyer_email, paystack_ref')
    .eq('id', requestId)
    .maybeSingle();
  if (loadErr) throw loadErr;
  if (!refundReq) return json({ status: false, message: 'Refund request not found' }, 404);

  const idempotencyKey = ensureIdempotencyKey(
    readIdempotencyKey(req, body) || `refund_process:${requestId}`,
  );
  const resumed = await tryResumeCompletedRequest(
    admin,
    refundReq.merchant_id,
    idempotencyKey,
    'refund_process',
    { refund_request_id: requestId },
  );
  if (resumed.hit) {
    return json({
      status: true,
      idempotent: true,
      retry_count: resumed.retryCount,
      message: String(resumed.payload.message ?? 'Refund already queued with Paystack'),
      paystack_ref: resumed.payload.paystack_ref ?? null,
      paystack_status: resumed.payload.paystack_status ?? null,
    });
  }

  if (refundReq.status !== 'pending') {
    if (refundReq.status === 'processing' && refundReq.paystack_ref) {
      return json({
        status: true,
        idempotent: true,
        message: 'Refund already queued with Paystack',
        paystack_ref: refundReq.paystack_ref,
      });
    }
    return json({ status: false, message: `Refund is already ${refundReq.status}` }, 400);
  }

  const adminEmail = await requireAdmin(req);
  let actorEmail = adminEmail;
  if (!adminEmail) {
    const merchantUser = await requireMerchant(req);
    if (!merchantUser || merchantUser.merchant.id !== refundReq.merchant_id) {
      return json({ status: false, message: 'Not authorized to process this refund' }, 403);
    }
    actorEmail = merchantUser.email;
  }

  const { data: txn, error: txnErr } = await admin
    .from('transactions')
    .select('id, reference, status, amount')
    .eq('id', refundReq.transaction_id)
    .maybeSingle();
  if (txnErr) throw txnErr;
  if (!txn?.reference) return json({ status: false, message: 'Payment reference missing' }, 400);
  if (txn.status !== 'success') return json({ status: false, message: 'Only successful payments can be refunded' }, 400);

  const refund = await createPaystackRefund({
    transactionReference: txn.reference,
    amountMajor: Number(refundReq.amount),
    currency: refundReq.currency ?? undefined,
    customerNote: refundReq.reason ? `Refund: ${refundReq.reason}` : 'Refund from RedFace Pay',
    merchantNote: `Refund requested by ${actorEmail}`,
    secret: secret(),
  });

  if (!refund.ok) {
    await admin.from('merchant_refund_requests').update({
      status: 'rejected',
      error_message: refund.message,
    }).eq('id', requestId);
    return json({ status: false, message: refund.message, paystack: refund.raw }, 400);
  }

  await admin.from('merchant_refund_requests').update({
    status: 'processing',
    paystack_ref: refund.paystackId || null,
    error_message: null,
  }).eq('id', requestId);

  const refundPayload = {
    message: 'Refund queued with Paystack',
    paystack_ref: refund.paystackId,
    paystack_status: refund.paystackStatus,
  };

  await completePaymentRequest(admin, {
    merchantId: refundReq.merchant_id,
    idempotencyKey,
    requestType: 'refund_process',
    status: 'completed',
    transactionReference: txn.reference,
    responsePayload: refundPayload,
  });

  return json({
    status: true,
    ...refundPayload,
  });
}

/** Admin: fetch Paystack master balance and cache for ops dashboard. */
async function refreshPlatformBalance(req: Request) {
  const who = await requireAdmin(req);
  if (!who) return json({ status: false, message: 'Admin only.' }, 403);

  const bal = await fetchPaystackBalance(secret());
  if (!bal.ok) {
    return json({ status: false, message: bal.message ?? 'Could not fetch Paystack balance' }, 502);
  }

  await admin.rpc('upsert_platform_paystack_balance', {
    p_balance: bal.balance,
    p_currency: bal.currency,
    p_raw: bal.raw ?? [],
  });

  return json({
    status: true,
    balance: bal.balance,
    currency: bal.currency,
    updated_at: new Date().toISOString(),
  });
}

async function createTransferRecipient(body: Record<string, unknown>, req: Request) {
  const auth = await requireMerchant(req);
  if (!auth) return json({ status: false, message: 'Sign in as an approved merchant.' }, 403);

  const merchantId = String(body.merchant_id ?? auth.merchant.id);
  if (merchantId !== auth.merchant.id && !(await requireAdmin(req))) {
    return json({ status: false, message: 'Not authorized for this merchant.' }, 403);
  }

  const label = String(body.label ?? '').trim();
  const accountName = String(body.account_name ?? '').trim();
  const bankCode = String(body.bank_code ?? '').trim();
  const bankAccount = String(body.account_number ?? body.bank_account ?? '').trim();
  const currency = String(body.currency ?? (auth.merchant.country === 'Nigeria' ? 'NGN' : 'ZAR'));

  if (!label || !accountName || !bankCode || !bankAccount) {
    return json({ status: false, message: 'label, account_name, bank_code, and account_number are required.' }, 400);
  }

  const ps = await createPaystackTransferRecipient(secret(), {
    name: accountName,
    account_number: bankAccount,
    bank_code: bankCode,
    currency,
  });
  if (!ps.ok) {
    return json({ status: false, message: ps.message ?? 'Paystack could not create recipient.' }, 400);
  }

  const recipientCode = String((ps.data as { recipient_code?: string })?.recipient_code ?? '');
  if (!recipientCode) {
    return json({ status: false, message: 'Paystack did not return a recipient code.' }, 502);
  }

  const { data: row, error } = await admin
    .from('merchant_transfer_recipients')
    .insert({
      merchant_id: merchantId,
      label,
      account_name: accountName,
      bank_code: bankCode,
      bank_account: bankAccount,
      currency,
      paystack_recipient_code: recipientCode,
    })
    .select('id, label, account_name, paystack_recipient_code, currency, created_at')
    .single();

  if (error) return json({ status: false, message: error.message }, 500);
  return json({ status: true, data: row });
}

async function initiateTransfer(body: Record<string, unknown>, req: Request) {
  const auth = await requireMerchant(req);
  if (!auth) return json({ status: false, message: 'Sign in as an approved merchant.' }, 403);

  const merchantId = String(body.merchant_id ?? auth.merchant.id);
  if (merchantId !== auth.merchant.id && !(await requireAdmin(req))) {
    return json({ status: false, message: 'Not authorized for this merchant.' }, 403);
  }

  const recipientId = String(body.recipient_id ?? '');
  const amount = Number(body.amount ?? 0);
  const reason = String(body.reason ?? 'RedFace payout').trim();
  const currency = String(body.currency ?? 'ZAR');

  if (!recipientId || !(amount > 0)) {
    return json({ status: false, message: 'recipient_id and amount are required.' }, 400);
  }

  const { data: recipient } = await admin
    .from('merchant_transfer_recipients')
    .select('id, paystack_recipient_code, label, is_active')
    .eq('id', recipientId)
    .eq('merchant_id', merchantId)
    .maybeSingle();

  if (!recipient?.paystack_recipient_code || !recipient.is_active) {
    return json({ status: false, message: 'Recipient not found or inactive.' }, 404);
  }

  const reference = `RFT-${merchantId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`.toUpperCase();

  const { data: requestRow, error: insertErr } = await admin
    .from('merchant_transfer_requests')
    .insert({
      merchant_id: merchantId,
      recipient_id: recipientId,
      amount,
      currency,
      reason,
      status: 'processing',
      paystack_reference: reference,
      initiated_by: auth.email,
    })
    .select('id')
    .single();

  if (insertErr) return json({ status: false, message: insertErr.message }, 500);

  const ps = await initiatePaystackTransfer(secret(), {
    amountMajor: amount,
    recipientCode: recipient.paystack_recipient_code,
    reason,
    reference,
    currency,
    merchantId,
  });

  if (!ps.ok) {
    await admin.from('merchant_transfer_requests').update({
      status: 'failed',
      error_message: ps.message ?? 'Transfer failed',
    }).eq('id', requestRow.id);
    return json({ status: false, message: ps.message ?? 'Paystack transfer failed.' }, 400);
  }

  const transferCode = String((ps.data as { transfer_code?: string })?.transfer_code ?? '');
  await admin.from('merchant_transfer_requests').update({
    transfer_code: transferCode || null,
    status: 'processing',
  }).eq('id', requestRow.id);

  return json({
    status: true,
    reference,
    transfer_code: transferCode,
    request_id: requestRow.id,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ status: false, message: 'Method Not Allowed' }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ status: false, message: 'Invalid JSON body' }, 400);
  }

  // Supabase Database Webhook payload (INSERT on merchants) → notify admins.
  if (body.type === 'INSERT' && body.table === 'merchants' && body.record) {
    if (!authorizeCron(req)) {
      return json({ status: false, message: 'Not authorized.' }, 401);
    }
    try {
      return await notifyApplication(body);
    } catch (err) {
      console.error('redface-pay webhook notify error', err);
      return json({ status: false, message: 'notify failed' }, 500);
    }
  }

  const action = String(body.action ?? '');

  try {
    switch (action) {
      // --- Payments ---
      case 'init_payment':
        return await initPayment(body, req);
      case 'init_marketplace_checkout':
        return await initMarketplaceCheckout(body, req);
      case 'create_payment_session':
        return await createPaymentSession(body, req);
      case 'send_payment_request':
        return await sendPaymentRequest(body, req);
      case 'charge_saved_card':
        return await chargeSavedCard(body, req);
      case 'charge_card':
        return await chargeCard(body, req);
      case 'cancel_payment_session':
        return await cancelPaymentSession(body, req);
      case 'get_payment_session':
        return await getPaymentSession(body, req);
      case 'get_merchant_capabilities':
        return await getMerchantCapabilities(req);
      case 'init_domain_payment':
        return await initDomainPayment(body, req);
      case 'init_domain_renewal_payment':
        return await initDomainRenewalPayment(body, req);
      case 'init_plan_subscription':
        return await initPlanSubscription(body, req);
      case 'init_developer_api_subscription':
        return await initDeveloperApiSubscription(body, req);
      case 'cancel_plan_subscription':
        return await cancelPlanSubscription(req);
      case 'cancel_developer_api_subscription':
        return await cancelDeveloperApiSubscription(req);
      case 'cancel_customer_subscription':
        return await cancelCustomerSubscription(body, req);
      case 'get_payment_dispute_upload_url':
        return await getPaymentDisputeUploadUrl(body, req);
      case 'resolve_payment_dispute':
        return await resolvePaymentDispute(body, req);
      case 'init_studio_subscription':
        return await initStudioSubscription(body, req);
      case 'confirm_studio_subscription':
        return await confirmStudioSubscription(body, req);
      case 'init_sponsored_listing':
        return await initSponsoredListing(body, req);
      case 'confirm_payment':
        return await confirmPayment(body);

      // --- Mobility / Takasit fare lifecycle ---
      case 'authorize_payment':
        return await authorizePayment(body);
      case 'capture_payment':
        return await capturePayment(body);
      case 'void_payment':
        return await voidPayment(body);

      // --- Campaign automation ---
      case 'preview_campaign':
        return await previewCampaign(body, req);
      case 'send_campaign':
        return await sendCampaign(body, req);
      case 'process_scheduled_campaigns':
        return await processScheduledCampaigns(req);
      case 'process_abandoned_cart_reminders':
        return await processAbandonedCartRemindersJob(req);

      // --- Team / staff invites ---
      case 'invite_staff':
        return await inviteStaff(body, req);
      case 'resend_staff_invite':
        return await resendStaffInvite(body, req);

      // --- Refunds ---
      case 'process_refund':
        return await processRefund(body, req);

      case 'refresh_platform_balance':
        return await refreshPlatformBalance(req);

      case 'create_transfer_recipient':
        return await createTransferRecipient(body, req);
      case 'initiate_transfer':
        return await initiateTransfer(body, req);
      case 'provision_dedicated_account':
        return await provisionDedicatedAccount(body, req);
      case 'get_dedicated_account':
        return await getDedicatedAccount(body, req);

      case 'create_crypto_payment':
        return await createCryptoPayment(body, req);
      case 'create_public_crypto_payment':
        return await createPublicCryptoPayment(body, req);

      // --- Admin / provisioning (locked to the admin allow-list) ---
      case 'create_subaccount': {
        const who = await requireAdmin(req);
        if (!who) return json({ status: false, message: 'Not authorized. Only an admin can approve merchants.' }, 403);
        return await createSubaccount({ ...body, actor_email: who });
      }
      case 'tick3t_provision_subaccount':
        return await tick3tProvisionSubaccount(body, req);
      case 'set_merchant_status': {
        const who = await requireAdmin(req);
        if (!who) return json({ status: false, message: 'Not authorized. Only an admin can change merchant status.' }, 403);
        return await setMerchantStatus({ ...body, actor_email: who });
      }
      case 'notify_application': {
        const merchantId = String(body.merchant_id ?? '');
        if (!merchantId) return json({ status: false, message: 'merchant_id is required' }, 400);
        if (!(await authorizeNotifyApplication(req, merchantId))) {
          return json({ status: false, message: 'Not authorized for this merchant.' }, 403);
        }
        return await notifyApplication(body);
      }
      case 'boss_notify':
        return await handleBossNotify(body, req);

      case 'send_signup_verification':
        return await handleSendSignupVerification(body);
      case 'verify_signup_email':
        return await handleVerifySignupEmail(body);

      // --- Bank verification (list is public; validate costs Paystack quota) ---
      case 'list_banks':
        return json(await listBanks(body));
      case 'resolve_account':
        return json(await resolveAccount(body));
      case 'validate_account':
        return json(await validateAccount(body));

      // --- Apple Pay domains (admin only) ---
      case 'applepay_register_domain': {
        const who = await requireAdmin(req);
        if (!who) return json({ status: false, message: 'Admin only.' }, 403);
        return json(await registerApplePayDomain(body));
      }
      case 'applepay_list_domains': {
        const who = await requireAdmin(req);
        if (!who) return json({ status: false, message: 'Admin only.' }, 403);
        return json(await listApplePayDomains());
      }
      case 'applepay_unregister_domain': {
        const who = await requireAdmin(req);
        if (!who) return json({ status: false, message: 'Admin only.' }, 403);
        return json(await unregisterApplePayDomain(body));
      }

      default:
        return json({ status: false, message: `Unknown action: ${action || '(none)'}` }, 400);
    }
  } catch (err) {
    console.error('redface-pay error', action, err);
    const message = err instanceof Error ? err.message : 'Internal error';
    return json({ status: false, message }, 500);
  }
});
