/** Resolve marketplace cart lines grouped by merchant (multi-vendor checkout). */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { feePlanFromMerchant } from './feePlan.ts';
import { type CartLine, cartLabel } from './cartItems.ts';

export type VendorCartBucket = {
  merchantId: string;
  businessName: string;
  paystackSubaccount: string;
  merchantPlan: string | null;
  platformFeePercent: number | null;
  platformFeeCap: number | null;
  items: CartLine[];
  subtotal: number;
};

export async function resolveMultiVendorCart(
  admin: SupabaseClient,
  cartItems: unknown,
): Promise<{ vendors: VendorCartBucket[]; total: number; currency: string } | { error: string }> {
  const raw = Array.isArray(cartItems) ? cartItems : [];
  if (!raw.length) return { error: 'cart_items is empty' };

  type PendingLine = { productId: string; variantId: string | null; qty: number };
  const pending: PendingLine[] = [];
  for (const row of raw) {
    const rec = row as Record<string, unknown>;
    const productId = String(rec.product_id ?? '').trim();
    const variantId = String(rec.variant_id ?? rec.variantId ?? '').trim() || null;
    const qty = Math.max(1, Math.min(99, Number(rec.quantity ?? rec.qty) || 1));
    if (!productId) return { error: 'cart item missing product_id' };
    pending.push({ productId, variantId, qty });
  }

  const productIds = [...new Set(pending.map((p) => p.productId))];
  const { data: products, error: prodErr } = await admin
    .from('products')
    .select('id, name, price, merchant_id, billing_type, track_inventory, stock_quantity, currency')
    .in('id', productIds);
  if (prodErr) return { error: prodErr.message || 'Could not load products' };

  const productMap = new Map((products ?? []).map((p) => [p.id as string, p]));
  const merchantIds = [...new Set((products ?? []).map((p) => p.merchant_id as string))];

  const { data: merchants, error: merchErr } = await admin
    .from('merchants')
    .select('id, business_name, status, paystack_subaccount, paystack_split_code, merchant_plan, subscription_status, platform_fee_percent, platform_fee_cap')
    .in('id', merchantIds);
  if (merchErr) return { error: merchErr.message || 'Could not load merchants' };

  const merchantMap = new Map((merchants ?? []).map((m) => [m.id as string, m]));
  const buckets = new Map<string, VendorCartBucket>();
  let currency = 'ZAR';

  for (const line of pending) {
    const p = productMap.get(line.productId);
    if (!p) return { error: 'A product in your cart is no longer available' };
    if (p.billing_type === 'subscription') {
      return { error: 'Subscription products must be purchased separately' };
    }

    const merchantId = String(p.merchant_id);
    const merchant = merchantMap.get(merchantId);
    if (!merchant || merchant.status !== 'approved') {
      return { error: 'A seller in your cart is not available for checkout' };
    }

    const routeCode = String(merchant.paystack_split_code || merchant.paystack_subaccount || '').trim();
    if (!routeCode.startsWith('ACCT_') && !routeCode.startsWith('SPL_')) {
      return { error: `${merchant.business_name} is not ready to receive marketplace payments yet` };
    }
    if (routeCode.startsWith('SPL_')) {
      return { error: `${merchant.business_name} uses legacy split routing — contact support for multi-seller checkout` };
    }

    let unitPrice = Number(p.price);
    let variantLabel: string | null = null;
    if (line.variantId) {
      const { data: variant } = await admin
        .from('product_variants')
        .select('id, label, price, stock_quantity, active')
        .eq('id', line.variantId)
        .eq('product_id', line.productId)
        .maybeSingle();
      if (!variant || !variant.active) return { error: 'A selected size/variant is no longer available' };
      unitPrice = Number(variant.price ?? p.price);
      variantLabel = variant.label;
      if (variant.stock_quantity != null && Number(variant.stock_quantity) < line.qty) {
        return { error: `${p.name} (${variant.label}) is out of stock` };
      }
    } else if (p.track_inventory && Number(p.stock_quantity || 0) < line.qty) {
      return { error: `${p.name} is out of stock` };
    }

    currency = String(p.currency || currency || 'ZAR');

    if (!buckets.has(merchantId)) {
      buckets.set(merchantId, {
        merchantId,
        businessName: String(merchant.business_name ?? 'Seller'),
        paystackSubaccount: routeCode,
        merchantPlan: feePlanFromMerchant(merchant),
        platformFeePercent: merchant.platform_fee_percent != null ? Number(merchant.platform_fee_percent) : null,
        platformFeeCap: merchant.platform_fee_cap != null ? Number(merchant.platform_fee_cap) : null,
        items: [],
        subtotal: 0,
      });
    }

    const bucket = buckets.get(merchantId)!;
    bucket.items.push({
      product_id: p.id as string,
      name: p.name as string,
      price: unitPrice,
      quantity: line.qty,
      ...(line.variantId ? { variant_id: line.variantId, variant_label: variantLabel ?? undefined } : {}),
    });
    bucket.subtotal += unitPrice * line.qty;
  }

  const vendors = [...buckets.values()];
  if (vendors.length < 2) {
    return { error: 'Multi-seller checkout requires items from at least two sellers' };
  }

  const total = vendors.reduce((n, v) => n + v.subtotal, 0);
  if (!(total > 0)) return { error: 'cart total must be greater than zero' };

  return { vendors, total, currency };
}

export function marketplaceCartLabel(vendors: VendorCartBucket[]): string {
  const lines = vendors.flatMap((v) => v.items);
  return cartLabel(lines);
}
