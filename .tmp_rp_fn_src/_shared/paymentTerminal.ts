/**
 * Payment Terminal abstraction — SoftPOS-ready.
 *
 * Doctrine: the UI must never know whether the merchant is using an NFC card,
 * SoftPOS phone, QR, payment link, or external reader. Every payment source
 * implements the same terminal contract. SoftPOS partners plug in by registering
 * a rail + flipping terminal.provider — business modules stay unchanged.
 *
 * @see docs/codex/platform/financial-abstraction-layer.md
 * @see docs/codex/platform/commerce-intelligence-engine-doctrine.md
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { CaptureMethod } from './paymentRouting.ts';

export type TerminalKind =
  | 'nfc_card'
  | 'softpos'
  | 'qr'
  | 'payment_link'
  | 'cash'
  | 'external_reader';

export type TerminalStatus = 'active' | 'inactive' | 'pending_onboarding';

/**
 * First-class payment terminal. NFC cards (payment_objects) are one kind;
 * SoftPOS phones, QR posters, and payment links are others.
 */
export type PaymentTerminal = {
  id: string;
  kind: TerminalKind;
  label: string;
  status: TerminalStatus;
  merchantId: string;
  /** Capture method this terminal asks the Routing Engine to settle. */
  captureMethod: CaptureMethod;
  /** SoftPOS / acquiring partner when kind requires one. */
  provider: string | null;
  tapCode: string | null;
  locationId: string | null;
  deviceRef: string | null;
  supportedMethods: string[];
  capabilities: string[];
};

export type PaymentObjectRow = {
  id: string;
  merchant_id: string;
  label: string | null;
  tap_code: string | null;
  medium: string | null;
  status: string | null;
  type: string | null;
  metadata?: Record<string, unknown> | null;
};

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = meta?.[key];
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * Map a payment_object row → PaymentTerminal.
 * SoftPOS objects carry metadata.terminal_kind = 'softpos' + metadata.provider.
 */
export function paymentObjectToTerminal(row: PaymentObjectRow): PaymentTerminal {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const kindRaw = metaString(meta, 'terminal_kind') ?? metaString(meta, 'kind');
  const medium = String(row.medium ?? '').toLowerCase();
  const provider = metaString(meta, 'provider') ?? metaString(meta, 'softpos_partner');

  let kind: TerminalKind = 'nfc_card';
  if (kindRaw === 'softpos' || medium === 'softpos') kind = 'softpos';
  else if (kindRaw === 'qr' || medium === 'qr') kind = 'qr';
  else if (kindRaw === 'external_reader' || medium === 'reader') kind = 'external_reader';
  else if (row.tap_code || medium === 'nfc' || medium === 'tag') kind = 'nfc_card';

  const captureMethod: CaptureMethod =
    kind === 'softpos'
      ? (provider === 'istore_tap' ? 'apple_tap' : 'softpos')
      : kind === 'qr'
        ? 'qr'
        : kind === 'external_reader'
          ? 'external_terminal'
          : 'nfc_tap';

  const status: TerminalStatus =
    row.status === 'active'
      ? (kind === 'softpos' && !provider ? 'pending_onboarding' : 'active')
      : row.status === 'pending'
        ? 'pending_onboarding'
        : 'inactive';

  return {
    id: String(row.id),
    kind,
    label: String(row.label ?? (kind === 'softpos' ? 'SoftPOS' : 'Terminal')),
    status,
    merchantId: String(row.merchant_id),
    captureMethod,
    provider,
    tapCode: row.tap_code ? String(row.tap_code) : null,
    locationId: metaString(meta, 'location_id'),
    deviceRef: metaString(meta, 'device_ref') ?? metaString(meta, 'device'),
    supportedMethods: kind === 'cash'
      ? ['cash']
      : kind === 'softpos'
        ? ['softpos', 'apple_tap', 'card_present']
        : ['nfc_tap', 'qr', 'payment_link'],
    capabilities: [
      'collect_payment',
      ...(kind === 'nfc_card' || kind === 'softpos' ? ['pos_terminal'] : []),
      ...(kind === 'softpos' ? ['softpos'] : []),
    ],
  };
}

/** Synthetic terminals that are not payment_objects (cash drawer, pay-by-link). */
export function syntheticTerminals(merchantId: string): PaymentTerminal[] {
  return [
    {
      id: `synthetic:cash:${merchantId}`,
      kind: 'cash',
      label: 'Cash',
      status: 'active',
      merchantId,
      captureMethod: 'cash',
      provider: null,
      tapCode: null,
      locationId: null,
      deviceRef: null,
      supportedMethods: ['cash'],
      capabilities: ['collect_payment', 'cash_register'],
    },
    {
      id: `synthetic:link:${merchantId}`,
      kind: 'payment_link',
      label: 'Payment link',
      status: 'active',
      merchantId,
      captureMethod: 'payment_link',
      provider: null,
      tapCode: null,
      locationId: null,
      deviceRef: null,
      supportedMethods: ['payment_link'],
      capabilities: ['collect_payment', 'share_link'],
    },
  ];
}

export async function listPaymentTerminals(
  admin: SupabaseClient,
  merchantId: string,
  opts?: { includeSynthetic?: boolean },
): Promise<PaymentTerminal[]> {
  let data: PaymentObjectRow[] | null = null;

  const withMeta = await admin
    .from('payment_objects')
    .select('id, merchant_id, label, tap_code, medium, status, type, metadata')
    .eq('merchant_id', merchantId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(100);

  if (!withMeta.error) {
    data = (withMeta.data ?? []) as PaymentObjectRow[];
  } else {
    // metadata column may not exist until migration 0270
    const fallback = await admin
      .from('payment_objects')
      .select('id, merchant_id, label, tap_code, medium, status, type')
      .eq('merchant_id', merchantId)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(100);
    if (fallback.error) {
      return opts?.includeSynthetic === false ? [] : syntheticTerminals(merchantId);
    }
    data = (fallback.data ?? []) as PaymentObjectRow[];
  }

  const fromObjects = data.map((row) => paymentObjectToTerminal(row));

  if (opts?.includeSynthetic === false) return fromObjects;
  return [...fromObjects, ...syntheticTerminals(merchantId)];
}

export async function getPaymentTerminal(
  admin: SupabaseClient,
  merchantId: string,
  terminalId: string,
): Promise<PaymentTerminal | null> {
  if (terminalId.startsWith('synthetic:')) {
    return syntheticTerminals(merchantId).find((t) => t.id === terminalId) ?? null;
  }
  const { data } = await admin
    .from('payment_objects')
    .select('id, merchant_id, label, tap_code, medium, status, type, metadata')
    .eq('id', terminalId)
    .eq('merchant_id', merchantId)
    .maybeSingle();
  if (!data) return null;
  return paymentObjectToTerminal(data as PaymentObjectRow);
}

/** Capture method the Routing Engine should use for this terminal. */
export function terminalCaptureMethod(terminal: PaymentTerminal): CaptureMethod {
  return terminal.captureMethod;
}
