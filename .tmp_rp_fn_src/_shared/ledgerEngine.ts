/**
 * Ledger Engine — the mandatory write path for payment truth.
 *
 * Platform Invariants (docs/codex/platform/platform-invariants.md):
 * - IX: The Ledger is the source of truth; providers are external evidence.
 * - III/IV: Every write is idempotent; entries are immutable after commit.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { appendPlatformPaymentEvent } from './platformPaymentSpine.ts';
import { consumePaymentRecorded } from './consumePaymentRecorded.ts';
import {
  createBusinessFactEnvelope,
  envelopeIntoPayload,
} from './businessFactEnvelope.ts';

export type LedgerRecordResult = {
  ok: boolean;
  created: boolean;
  error?: string;
  factId?: string | null;
};

export async function recordPaymentLedgerEntry(
  admin: SupabaseClient,
  opts: {
    reference: string;
    processingRail?: string | null;
    app?: string | null;
  },
): Promise<LedgerRecordResult> {
  const reference = String(opts.reference ?? '').trim();
  if (!reference) return { ok: false, created: false, error: 'reference_required' };

  const { data, error } = await admin.rpc('record_payment_ledger_entry', {
    p_reference: reference,
    p_processing_rail: opts.processingRail ?? null,
  });
  if (error) {
    console.error('record_payment_ledger_entry', reference, error.message);
    return { ok: false, created: false, error: error.message };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  if (row.ok !== true) {
    return { ok: false, created: false, error: String(row.error ?? 'ledger_write_failed') };
  }

  const created = row.created === true;
  let factId: string | null = null;
  if (created) {
    const merchantId = typeof row.merchant_id === 'string' ? row.merchant_id : null;
    const envelope = createBusinessFactEnvelope({
      type: 'payment.recorded',
      producer: 'commerce-kernel.ledger',
      merchantId,
      reference,
      payload: {
        txn_key: row.txn_key ?? null,
        business_intent: row.business_intent ?? null,
        processing_rail: row.processing_rail ?? opts.processingRail ?? null,
      },
    });

    factId = await appendPlatformPaymentEvent(admin, {
      eventType: envelope.type,
      reference,
      idempotencyKey: `ledger:${reference}`,
      app: opts.app ?? null,
      merchantId,
      amount: typeof row.amount === 'number' ? row.amount : Number(row.amount ?? 0) || null,
      currency: typeof row.currency === 'string' ? row.currency : null,
      payload: envelopeIntoPayload(envelope),
      correlationId: envelope.correlation_id,
      causationId: envelope.causation_id,
      eventVersion: envelope.version,
      producer: envelope.producer,
    });

    await consumePaymentRecorded(admin, {
      reference,
      merchantId,
      amount: typeof row.amount === 'number' ? row.amount : Number(row.amount ?? 0) || null,
      currency: typeof row.currency === 'string' ? row.currency : null,
      businessIntent: typeof row.business_intent === 'string' ? row.business_intent : null,
      processingRail: typeof row.processing_rail === 'string' ? row.processing_rail : null,
      txnKey: typeof row.txn_key === 'string' ? row.txn_key : null,
      correlationId: envelope.correlation_id,
      causationId: factId ?? envelope.id,
    });
  }
  return { ok: true, created, factId };
}
