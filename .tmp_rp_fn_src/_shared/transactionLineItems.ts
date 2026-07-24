import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type LineItemInput = {
  product_id?: string | null;
  name: string;
  quantity: number;
  unit_price: number;
  discount?: number;
  tax_amount?: number;
  line_total?: number;
  variant_label?: string | null;
  meta?: Record<string, unknown>;
};

function parseCartJson(json: string | null | undefined): LineItemInput[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
      return parsed.map((row, idx) => {
      const qty = Math.max(1, Number(row.quantity) || 1);
      const unit = Number(row.price ?? row.unit_price) || 0;
      const lineTotal = Number(row.line_total) || round2(unit * qty);
      return {
        product_id: row.product_id ?? null,
        name: String(row.name ?? 'Item'),
        quantity: qty,
        unit_price: unit,
        discount: Number(row.discount) || 0,
        tax_amount: Number(row.tax_amount) || 0,
        line_total: lineTotal,
        variant_label: row.variant_label ?? null,
        meta: {
          sort_order: idx,
          variant_id: row.variant_id ?? null,
          ...(row.category ? { category: String(row.category) } : {}),
          ...(row.category_id ? { category_id: String(row.category_id) } : {}),
          ...(typeof row.meta === 'object' ? row.meta : {}),
        },
      };
    }).filter((l) => l.name);
  } catch {
    return [];
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function linesFromSessionCartItems(cartItems: unknown): LineItemInput[] {
  if (!Array.isArray(cartItems) || cartItems.length === 0) return [];
  return cartItems.map((row, idx) => {
    const item = row as Record<string, unknown>;
    const qty = Math.max(1, Number(item.quantity ?? item.qty) || 1);
    const unit = Number(item.price ?? item.unit_price) || 0;
    return {
      product_id: item.product_id ? String(item.product_id) : null,
      name: String(item.name ?? 'Item'),
      quantity: qty,
      unit_price: unit,
      line_total: round2(Number(item.line_total) || unit * qty),
      variant_label: item.variant_label ? String(item.variant_label) : null,
      meta: {
        sort_order: idx,
        variant_id: item.variant_id ?? null,
        ...(item.category ? { category: String(item.category) } : {}),
        ...(item.category_id ? { category_id: String(item.category_id) } : {}),
        ...(typeof item.meta === 'object' && item.meta ? item.meta as Record<string, unknown> : {}),
      },
    };
  }).filter((l) => l.name);
}

/** Multi-vendor marketplace checkout (same inventory pipeline as standard cart). */
export function isMarketplaceCheckout(metadata: Record<string, unknown>): boolean {
  return String(metadata.object_type ?? '') === 'marketplace_cart'
    || metadata.marketplace_checkout === true
    || String(metadata.purchase_type ?? '') === 'marketplace_cart';
}

export function shouldSkipInventoryForPayment(metadata: Record<string, unknown>): boolean {
  // POS already deducted stock in record_pos_*_sale.
  if (String(metadata.pos_sale_id ?? '').trim()) return true;
  const purchaseType = String(metadata.purchase_type ?? '');
  if (
    purchaseType
    && purchaseType !== 'cart'
    && purchaseType !== 'product'
    && purchaseType !== 'marketplace_cart'
  ) {
    return true;
  }
  return false;
}

/** Resolve checkout metadata without provider APIs (session + platform spine). */
export async function resolveCheckoutMetadata(
  admin: SupabaseClient,
  input: {
    reference: string;
    paymentSessionId?: string | null;
    sessionMeta?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const meta: Record<string, unknown> = {
    ...(input.sessionMeta && typeof input.sessionMeta === 'object' ? input.sessionMeta : {}),
  };

  if (input.paymentSessionId) {
    const { data: sess } = await admin
      .from('payment_sessions')
      .select('metadata, cart_items')
      .eq('id', input.paymentSessionId)
      .maybeSingle();
    if (sess) {
      if (sess.metadata && typeof sess.metadata === 'object') {
        Object.assign(meta, sess.metadata as Record<string, unknown>);
      }
      const fromCart = linesFromSessionCartItems(sess.cart_items);
      if (fromCart.length && !meta.cart_items_json) {
        meta.cart_items_json = JSON.stringify(fromCart.map((l) => ({
          product_id: l.product_id,
          name: l.name,
          quantity: l.quantity,
          price: l.unit_price,
          line_total: l.line_total,
          variant_id: l.meta?.variant_id ?? null,
        })));
      }
    }
  }

  const { data: created } = await admin
    .from('platform_payment_events')
    .select('payload')
    .eq('paystack_reference', input.reference)
    .eq('event_type', 'payment.created')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (created?.payload && typeof created.payload === 'object') {
    Object.assign(meta, created.payload as Record<string, unknown>);
  }

  const { data: webhook } = await admin
    .from('platform_webhook_events')
    .select('payload')
    .eq('paystack_reference', input.reference)
    .eq('event_type', 'charge.success')
    .order('processed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const whPayload = webhook?.payload as Record<string, unknown> | undefined;
  const paystackMeta = (whPayload?.data as Record<string, unknown> | undefined)?.metadata;
  if (paystackMeta && typeof paystackMeta === 'object') {
    Object.assign(meta, paystackMeta as Record<string, unknown>);
  }

  return meta;
}

export async function applyInventoryForRecordedPayment(
  admin: SupabaseClient,
  input: {
    reference: string;
    transactionId: string;
    metadata: Record<string, unknown>;
  },
): Promise<{ applied: boolean; skipped?: boolean; reason?: string }> {
  if (shouldSkipInventoryForPayment(input.metadata)) {
    return { applied: false, skipped: true, reason: 'inventory_not_applicable' };
  }

  const { count } = await admin
    .from('stock_movements')
    .select('id', { count: 'exact', head: true })
    .eq('reason', `sale:${input.reference}`);
  if ((count ?? 0) > 0) {
    return { applied: false, skipped: true, reason: 'already_applied' };
  }

  const { data, error } = await admin.rpc('apply_inventory_from_transaction', {
    p_transaction_id: input.transactionId,
  });
  if (error) {
    console.error('apply_inventory_from_transaction', input.reference, error.message);
    return { applied: false, skipped: false, reason: error.message };
  }

  const row = (data ?? {}) as { ok?: boolean; skipped?: boolean; lines_applied?: number };
  if (row.skipped) return { applied: false, skipped: true, reason: 'rpc_skipped' };
  return { applied: (row.lines_applied ?? 0) > 0 };
}

/**
 * Flatten multi-vendor marketplace carts onto one parent transaction's line items.
 * Ownership (seller merchant_id) is carried in line meta for stock_movements.
 */
export async function loadMarketplaceLineItems(
  admin: SupabaseClient,
  reference: string,
): Promise<LineItemInput[]> {
  const ref = String(reference ?? '').trim();
  if (!ref) return [];

  const { data: checkout } = await admin
    .from('marketplace_checkouts')
    .select('id')
    .eq('reference', ref)
    .maybeSingle();
  if (!checkout?.id) return [];

  const { data: vendorRows } = await admin
    .from('marketplace_checkout_vendors')
    .select('merchant_id, cart_items_json')
    .eq('marketplace_checkout_id', checkout.id);

  const allLines: LineItemInput[] = [];
  for (const row of vendorRows ?? []) {
    const merchantId = String(row.merchant_id ?? '');
    const items = Array.isArray(row.cart_items_json)
      ? row.cart_items_json as Array<Record<string, unknown>>
      : [];
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const qty = Math.max(1, Number(item.quantity) || 1);
      const unit = Number(item.price ?? item.unit_price) || 0;
      const productId = item.product_id ? String(item.product_id) : null;
      allLines.push({
        product_id: productId,
        name: String(item.name ?? 'Item'),
        quantity: qty,
        unit_price: unit,
        line_total: round2(unit * qty),
        variant_label: item.variant_label ? String(item.variant_label) : null,
        meta: {
          sort_order: allLines.length,
          variant_id: item.variant_id ?? null,
          marketplace_checkout_id: checkout.id,
          merchant_id: merchantId,
        },
      });
    }
  }
  return allLines.filter((l) => l.name);
}

export async function loadTableTabLineItems(
  admin: SupabaseClient,
  paymentSessionId: string | null,
): Promise<LineItemInput[]> {
  if (!paymentSessionId) return [];
  const { data: tab } = await admin
    .from('table_tabs')
    .select('id')
    .eq('payment_session_id', paymentSessionId)
    .in('status', ['ready_to_pay', 'paying', 'paid', 'open'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!tab?.id) return [];

  const { data: items } = await admin
    .from('table_tab_items')
    .select('product_id, product_name, quantity, unit_price, line_total')
    .eq('tab_id', tab.id)
    .order('created_at', { ascending: true });

  return (items ?? []).map((row, idx) => ({
    product_id: row.product_id,
    name: row.product_name,
    quantity: Number(row.quantity) || 1,
    unit_price: Number(row.unit_price) || 0,
    line_total: Number(row.line_total) || 0,
    meta: { source: 'table_tab', tab_id: tab.id, sort_order: idx },
  }));
}

export async function persistTransactionLineItems(
  admin: SupabaseClient,
  input: {
    transactionId: string;
    reference: string;
    lines: LineItemInput[];
    tableTabId?: string | null;
  },
): Promise<void> {
  if (!input.lines.length) return;

  const { count } = await admin
    .from('transaction_line_items')
    .select('id', { count: 'exact', head: true })
    .eq('transaction_id', input.transactionId);
  if ((count ?? 0) > 0) return;

  const subtotal = round2(input.lines.reduce((s, l) => s + (l.line_total ?? l.unit_price * l.quantity), 0));
  const taxTotal = round2(input.lines.reduce((s, l) => s + (l.tax_amount ?? 0), 0));

  const rows = input.lines.map((l, idx) => ({
    transaction_id: input.transactionId,
    product_id: l.product_id ?? null,
    name: l.name,
    quantity: l.quantity,
    unit_price: l.unit_price,
    discount: l.discount ?? 0,
    tax_amount: l.tax_amount ?? 0,
    line_total: l.line_total ?? round2(l.unit_price * l.quantity),
    variant_label: l.variant_label ?? null,
    sort_order: idx,
    meta: l.meta ?? {},
  }));

  await admin.from('transaction_line_items').insert(rows);
  await admin.from('transactions').update({
    subtotal,
    tax_total: taxTotal,
    ...(input.tableTabId ? { table_tab_id: input.tableTabId } : {}),
  }).eq('id', input.transactionId);
}

export async function finalizePaymentLineItems(
  admin: SupabaseClient,
  input: {
    reference: string;
    metadata?: Record<string, unknown> | null;
    paymentSessionId?: string | null;
    /** When false, only persist line items (inventory handled by payment.recorded consumer). */
    applyInventory?: boolean;
  },
): Promise<void> {
  const { data: txn } = await admin
    .from('transactions')
    .select('id, payment_session_id')
    .eq('reference', input.reference)
    .maybeSingle();
  if (!txn?.id) return;

  let lines: LineItemInput[] = [];
  const meta = input.metadata ?? {};

  // Marketplace: load from vendor carts (independent of fan-out order).
  if (isMarketplaceCheckout(meta)) {
    lines = await loadMarketplaceLineItems(admin, input.reference);
  }

  const cartJson = String(meta.cart_items_json ?? '');
  if (!lines.length && cartJson) {
    lines = parseCartJson(cartJson);
  } else if (!lines.length && meta.product_id && meta.label) {
    const qty = Math.max(1, Number(meta.quantity) || 1);
    const unit = Number(meta.unit_price ?? meta.amount) || 0;
    lines = [{
      product_id: String(meta.product_id),
      name: String(meta.label),
      quantity: qty,
      unit_price: unit,
      line_total: round2(unit * qty),
    }];
  }

  const sessionId = input.paymentSessionId ?? txn.payment_session_id ?? null;
  let sessionLabel = '';
  if (!lines.length && sessionId) {
    const { data: sess } = await admin
      .from('payment_sessions')
      .select('cart_items, label, metadata')
      .eq('id', sessionId)
      .maybeSingle();
    if (sess?.cart_items) {
      lines = linesFromSessionCartItems(sess.cart_items);
    }
    const metaNotes = sess?.metadata && typeof sess.metadata === 'object'
      ? String((sess.metadata as Record<string, unknown>).notes ?? '').trim()
      : '';
    sessionLabel = String(sess?.label ?? '').trim() || metaNotes;
  }
  if (!lines.length && sessionId) {
    lines = await loadTableTabLineItems(admin, sessionId);
  }
  // Fallback when flags missing but checkout row exists (replay / older sessions).
  if (!lines.length) {
    lines = await loadMarketplaceLineItems(admin, input.reference);
  }

  // Get Paid free-text: session label / notes is what was sold (e.g. "2x apples").
  if (!lines.length) {
    const { data: txnAmount } = await admin
      .from('transactions')
      .select('amount')
      .eq('id', txn.id)
      .maybeSingle();
    const amount = Number(txnAmount?.amount) || 0;
    let soldAs = sessionLabel;
    if (!soldAs) {
      const { data: order } = await admin
        .from('buyer_orders')
        .select('product_name')
        .eq('transaction_id', txn.id)
        .maybeSingle();
      soldAs = String(order?.product_name ?? '').trim();
    }
    if (!soldAs) {
      soldAs = String(meta.label ?? meta.notes ?? '').trim();
    }
    if (soldAs && amount > 0) {
      lines = [{
        name: soldAs,
        quantity: 1,
        unit_price: amount,
        line_total: round2(amount),
        meta: { source: 'payment_description' },
      }];
    }
  }

  if (!lines.length) return;

  let tableTabId: string | null = null;
  if (sessionId) {
    const { data: tab } = await admin
      .from('table_tabs')
      .select('id')
      .eq('payment_session_id', sessionId)
      .limit(1)
      .maybeSingle();
    tableTabId = tab?.id ?? null;
  }

  await persistTransactionLineItems(admin, {
    transactionId: txn.id,
    reference: input.reference,
    lines,
    tableTabId,
  });

  if (input.applyInventory === false) return;

  // Split POS already deducted stock in record_pos_*_sale — skip second decrement.
  if (shouldSkipInventoryForPayment(meta)) return;

  await applyInventoryForRecordedPayment(admin, {
    reference: input.reference,
    transactionId: txn.id,
    metadata: meta,
  });
}

export { parseCartJson };
