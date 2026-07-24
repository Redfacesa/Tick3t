import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { markAbandonedCartRecovered } from './abandonedCart.ts';
import { createOrderFromPayment } from './orderCreate.ts';
import { persistTransactionLineItems, type LineItemInput } from './transactionLineItems.ts';
import type { VendorCartBucket } from './resolveMultiVendorCart.ts';

export type MarketplacePricing = {
  plan: string;
  percent: number;
  cap: number | null;
  feeSub: number;
  feeMajor: number;
  merchantShareMajor: number;
  merchantShareSub: number;
};

export function computeVendorPricing(
  subtotalMajor: number,
  toSubunits: (n: number) => number,
  computePricing: (input: {
    amountSub: number;
    plan?: string | null;
    customPercent?: number | null;
    capMajor?: number | null;
  }) => { plan: string; percent: number; cap: number | null; feeSub: number },
  vendor: VendorCartBucket,
): MarketplacePricing {
  const amountSub = toSubunits(subtotalMajor);
  const pricing = computePricing({
    amountSub,
    plan: vendor.merchantPlan,
    customPercent: vendor.platformFeePercent,
    capMajor: vendor.platformFeeCap,
  });
  const merchantShareSub = Math.max(0, amountSub - pricing.feeSub);
  return {
    plan: pricing.plan,
    percent: pricing.percent,
    cap: pricing.cap,
    feeSub: pricing.feeSub,
    feeMajor: pricing.feeSub / 100,
    merchantShareMajor: merchantShareSub / 100,
    merchantShareSub,
  };
}

export function buildPaystackFlatSplit(
  vendors: Array<{ paystackSubaccount: string; merchantShareSub: number }>,
): Record<string, unknown> {
  return {
    type: 'flat',
    bearer_type: 'account',
    subaccounts: vendors.map((v) => ({
      subaccount: v.paystackSubaccount,
      share: v.merchantShareSub,
    })),
  };
}

export async function fanOutMarketplaceCheckoutSuccess(
  admin: SupabaseClient,
  input: {
    reference: string;
    buyerEmail: string;
    buyerPhone?: string | null;
    currency: string;
    parentTransactionId?: string | null;
  },
): Promise<{ ok: boolean; orderNumbers?: string[]; message?: string }> {
  const { data: checkout } = await admin
    .from('marketplace_checkouts')
    .select('id, status, buyer_email, currency, total_amount')
    .eq('reference', input.reference)
    .maybeSingle();

  if (!checkout?.id) return { ok: false, message: 'marketplace checkout not found' };

  if (checkout.status === 'paid') {
    const { data: existingOrders } = await admin
      .from('buyer_orders')
      .select('order_number')
      .eq('marketplace_checkout_id', checkout.id);
    return { ok: true, orderNumbers: (existingOrders ?? []).map((o) => o.order_number as string) };
  }

  const { data: vendorRows } = await admin
    .from('marketplace_checkout_vendors')
    .select('*')
    .eq('checkout_id', checkout.id)
    .order('created_at', { ascending: true });

  if (!vendorRows?.length) return { ok: false, message: 'no vendor rows' };

  const orderNumbers: string[] = [];

  for (const row of vendorRows) {
    const merchantId = String(row.merchant_id);
    const cartJson = JSON.stringify(row.cart_items_json ?? []);
    const items = (row.cart_items_json ?? []) as Array<{ name: string; quantity: number }>;
    const label = items.length === 1
      ? (items[0].quantity > 1 ? `${items[0].name} × ${items[0].quantity}` : items[0].name)
      : `${items.length} items`;

    const order = await createOrderFromPayment(admin, {
      reference: input.reference,
      merchantId,
      amount: Number(row.subtotal),
      currency: input.currency || checkout.currency || 'ZAR',
      buyerEmail: input.buyerEmail,
      buyerPhone: input.buyerPhone,
      label,
      purchaseType: 'marketplace_cart',
      cartItemsJson: cartJson,
      marketplaceCheckoutId: checkout.id,
    });

    if (order.ok && order.order_number) {
      orderNumbers.push(order.order_number);
      const { data: orderRow } = await admin
        .from('buyer_orders')
        .select('id')
        .eq('marketplace_checkout_id', checkout.id)
        .eq('merchant_id', merchantId)
        .maybeSingle();

      await admin.from('marketplace_checkout_vendors').update({
        buyer_order_id: orderRow?.id ?? null,
      }).eq('id', row.id);

      await admin.rpc('award_loyalty_points', {
        p_merchant_id: merchantId,
        p_buyer_email: input.buyerEmail.toLowerCase(),
        p_amount: Number(row.subtotal),
        p_reference: `${input.reference}:${merchantId}`,
      }).then(() => {}, () => {});

      await markAbandonedCartRecovered(admin, merchantId, input.buyerEmail);
    }
  }

  if (input.parentTransactionId) {
    const allLines: LineItemInput[] = [];
    for (const row of vendorRows) {
      const merchantId = String(row.merchant_id);
      const vendorLines = (row.cart_items_json as Array<Record<string, unknown>> ?? []).map((item, idx) => {
        const qty = Math.max(1, Number(item.quantity) || 1);
        const unit = Number(item.price) || 0;
        return {
          product_id: String(item.product_id ?? ''),
          name: String(item.name ?? 'Item'),
          quantity: qty,
          unit_price: unit,
          line_total: Math.round(unit * qty * 100) / 100,
          variant_label: item.variant_label ? String(item.variant_label) : null,
          meta: { sort_order: idx, marketplace_checkout_id: checkout.id, merchant_id: merchantId },
        };
      });
      allLines.push(...vendorLines);
    }
    // Line items + inventory are owned by payment.recorded → Inventory Consumer.
    // Fan-out only mirrors lines onto the parent txn when the consumer has not yet
    // (idempotent persist). Never call apply_inventory_from_transaction here.
    if (allLines.length) {
      await persistTransactionLineItems(admin, {
        transactionId: input.parentTransactionId,
        reference: input.reference,
        lines: allLines,
      });
    }
  }

  await admin.from('marketplace_checkouts').update({
    status: 'paid',
    updated_at: new Date().toISOString(),
  }).eq('id', checkout.id);

  await admin.rpc('try_qualify_founding_and_referrals', {
    p_merchant_id: vendorRows[0].merchant_id,
  }).then(() => {}, () => {});

  return { ok: true, orderNumbers };
}
