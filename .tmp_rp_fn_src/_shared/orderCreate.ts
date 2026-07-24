import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SKIP_PURCHASE_TYPES = new Set([
  'plan_subscription',
  'product_subscription',
  'domain',
  'domain_renewal',
]);

export function normalizePhone(phone: string | null | undefined): string {
  return String(phone ?? '').replace(/\D/g, '');
}

export function generateOrderNumber(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'RF-';
  for (let i = 0; i < 6; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

export type CreateOrderInput = {
  reference: string;
  merchantId: string;
  amount: number;
  currency: string | null;
  buyerEmail: string;
  buyerPhone?: string | null;
  productId?: string | null;
  productName?: string | null;
  label?: string | null;
  invoiceId?: string | null;
  purchaseType?: string | null;
  cartItemsJson?: string | null;
  marketplaceCheckoutId?: string | null;
};

type CartLine = { product_id: string; name: string; price: number; quantity: number };

function parseCartLines(json: string | null | undefined): CartLine[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => ({
        product_id: String(row.product_id ?? ''),
        name: String(row.name ?? 'Item'),
        price: Number(row.price) || 0,
        quantity: Math.max(1, Number(row.quantity) || 1),
      }))
      .filter((l) => l.product_id);
  } catch {
    return [];
  }
}

export async function createOrderFromPayment(
  admin: SupabaseClient,
  input: CreateOrderInput,
): Promise<{ ok: boolean; order_number?: string; skipped?: boolean; message?: string }> {
  const purchaseType = String(input.purchaseType ?? '').trim();
  if (SKIP_PURCHASE_TYPES.has(purchaseType)) {
    return { ok: false, skipped: true };
  }
  if (!input.reference || !input.merchantId || !input.buyerEmail) {
    return { ok: false, message: 'missing required fields' };
  }

  const { data: existing } = input.marketplaceCheckoutId
    ? await admin
      .from('buyer_orders')
      .select('id, order_number')
      .eq('marketplace_checkout_id', input.marketplaceCheckoutId)
      .eq('merchant_id', input.merchantId)
      .maybeSingle()
    : await admin
      .from('buyer_orders')
      .select('id, order_number')
      .eq('reference', input.reference)
      .maybeSingle();
  if (existing?.order_number) {
    return { ok: true, order_number: existing.order_number };
  }

  const { data: txn } = await admin
    .from('transactions')
    .select('id, buyer_phone')
    .eq('reference', input.reference)
    .maybeSingle();

  let productName = String(input.productName || input.label || '').trim();
  const cartLines = parseCartLines(input.cartItemsJson);
  if (cartLines.length > 0) {
    if (cartLines.length === 1) {
      const line = cartLines[0];
      productName = line.quantity > 1 ? `${line.name} × ${line.quantity}` : line.name;
    } else {
      const units = cartLines.reduce((n, l) => n + l.quantity, 0);
      productName = `${cartLines.length} items (${units} units)`;
    }
  } else if (!productName && input.productId) {
    const { data: product } = await admin
      .from('products')
      .select('name')
      .eq('id', input.productId)
      .maybeSingle();
    productName = String(product?.name ?? '').trim();
  }
  if (!productName) productName = 'Order';

  const phone = normalizePhone(input.buyerPhone || (txn?.buyer_phone as string | null));

  let orderNumber = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    orderNumber = generateOrderNumber();
    const { data: clash } = await admin
      .from('buyer_orders')
      .select('id')
      .eq('order_number', orderNumber)
      .maybeSingle();
    if (!clash) break;
    if (attempt === 7) return { ok: false, message: 'could not allocate order number' };
  }

  const totalQty = cartLines.length
    ? cartLines.reduce((n, l) => n + l.quantity, 0)
    : 1;
  const primaryProductId = cartLines.length === 1
    ? cartLines[0].product_id
    : (input.productId || null);

  const { data: order, error } = await admin
    .from('buyer_orders')
    .insert({
      order_number: orderNumber,
      merchant_id: input.merchantId,
      transaction_id: txn?.id ?? null,
      reference: input.reference,
      buyer_email: input.buyerEmail.toLowerCase().trim(),
      buyer_phone: phone || null,
      product_id: primaryProductId,
      product_name: productName,
      amount: input.amount,
      currency: input.currency || 'ZAR',
      status: 'confirmed',
      invoice_id: input.invoiceId || null,
      quantity: totalQty,
      marketplace_checkout_id: input.marketplaceCheckoutId || null,
      meta: cartLines.length ? { line_items: cartLines } : {},
    })
    .select('id, order_number')
    .single();

  if (error || !order) {
    return { ok: false, message: error?.message || 'order insert failed' };
  }

  await admin.from('buyer_order_events').insert({
    order_id: order.id,
    status: 'confirmed',
    note: 'Payment received — order created',
    actor: 'system',
  });

  return { ok: true, order_number: order.order_number };
}
