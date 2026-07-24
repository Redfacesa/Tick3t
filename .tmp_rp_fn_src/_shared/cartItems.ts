/** Resolve POS cart lines from product / variant IDs. */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type CartLine = {
  product_id: string;
  name: string;
  price: number;
  quantity: number;
  variant_id?: string;
  variant_label?: string;
  category_id?: string;
  category?: string;
};

export async function resolveCartItems(
  admin: SupabaseClient,
  merchantId: string,
  cartItems: unknown,
): Promise<{ items: CartLine[]; total: number } | { error: string }> {
  const raw = Array.isArray(cartItems) ? cartItems : [];
  if (!raw.length) return { error: 'cart_items is empty' };

  const lines: CartLine[] = [];
  let total = 0;
  for (const row of raw) {
    const rec = row as Record<string, unknown>;
    const productId = String(rec.product_id ?? '').trim();
    const variantId = String(rec.variant_id ?? rec.variantId ?? '').trim() || null;
    const qty = Math.max(1, Math.min(99, Number(rec.quantity ?? rec.qty) || 1));
    if (!productId) return { error: 'cart item missing product_id' };

    const { data: p } = await admin
      .from('products')
      .select('id, name, price, merchant_id, billing_type, track_inventory, stock_quantity, category_id')
      .eq('id', productId)
      .eq('merchant_id', merchantId)
      .maybeSingle();
    if (!p) return { error: 'A product in your cart is no longer available' };
    if (p.billing_type === 'subscription') {
      return { error: 'Subscription products must be purchased separately' };
    }

    let unitPrice = Number(p.price);
    let variantLabel: string | null = null;
    if (variantId) {
      const { data: variant } = await admin
        .from('product_variants')
        .select('id, label, price, stock_quantity, active')
        .eq('id', variantId)
        .eq('product_id', productId)
        .maybeSingle();
      if (!variant || !variant.active) return { error: 'A selected size/variant is no longer available' };
      unitPrice = Number(variant.price ?? p.price);
      variantLabel = variant.label;
      if (variant.stock_quantity != null && Number(variant.stock_quantity) < qty) {
        return { error: `${p.name} (${variant.label}) is out of stock` };
      }
    } else if (p.track_inventory && Number(p.stock_quantity || 0) < qty) {
      return { error: `${p.name} is out of stock` };
    }

    let categoryId: string | undefined;
    let categoryName: string | undefined;
    if (p.category_id) {
      categoryId = String(p.category_id);
      const { data: cat } = await admin
        .from('product_categories')
        .select('id, name')
        .eq('id', p.category_id)
        .maybeSingle();
      if (cat?.name) categoryName = String(cat.name);
    }

    lines.push({
      product_id: p.id,
      name: p.name,
      price: unitPrice,
      quantity: qty,
      ...(variantId ? { variant_id: variantId, variant_label: variantLabel ?? undefined } : {}),
      ...(categoryId ? { category_id: categoryId } : {}),
      ...(categoryName ? { category: categoryName } : {}),
    });
    total += unitPrice * qty;
  }
  if (!(total > 0)) return { error: 'cart total must be greater than zero' };
  return { items: lines, total };
}

export function cartLabel(lines: CartLine[]): string {
  if (lines.length === 1) {
    const l = lines[0];
    return l.quantity > 1 ? `${l.name} × ${l.quantity}` : l.name;
  }
  const units = lines.reduce((n, l) => n + l.quantity, 0);
  return `${lines.length} items (${units} units)`;
}
