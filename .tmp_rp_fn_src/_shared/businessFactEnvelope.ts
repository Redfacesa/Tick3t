/**
 * Business Fact Envelope — shared shape for every kernel-emitted fact.
 *
 * correlation_id ties together one business operation (e.g. a checkout).
 * causation_id names the immediate parent fact that caused this one.
 *
 * @see docs/codex/platform/commerce-language-specification.md
 */

export type BusinessFactEnvelope = {
  id: string;
  type: string;
  version: number;
  occurred_at: string;
  producer: string;
  correlation_id: string;
  causation_id: string | null;
  merchant_id: string | null;
  reference: string | null;
  payload: Record<string, unknown>;
};

export type CreateEnvelopeOpts = {
  type: string;
  producer?: string;
  merchantId?: string | null;
  reference?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  version?: number;
  payload?: Record<string, unknown>;
  /** Stable id for idempotent emission; defaults to a new UUID. */
  id?: string | null;
};

export function correlationIdForPayment(reference: string): string {
  return `corr_pay_${String(reference).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}`;
}

export function createBusinessFactEnvelope(opts: CreateEnvelopeOpts): BusinessFactEnvelope {
  const reference = opts.reference ? String(opts.reference) : null;
  const correlation =
    String(opts.correlationId ?? '').trim()
    || (reference ? correlationIdForPayment(reference) : `corr_${crypto.randomUUID().replace(/-/g, '')}`);

  return {
    id: String(opts.id ?? '').trim() || crypto.randomUUID(),
    type: opts.type,
    version: opts.version ?? 1,
    occurred_at: new Date().toISOString(),
    producer: opts.producer ?? 'commerce-kernel',
    correlation_id: correlation,
    causation_id: opts.causationId ? String(opts.causationId) : null,
    merchant_id: opts.merchantId ?? null,
    reference,
    payload: opts.payload ?? {},
  };
}

/** Flatten envelope metadata into a payload object for legacy RPC callers. */
export function envelopeIntoPayload(envelope: BusinessFactEnvelope): Record<string, unknown> {
  return {
    ...envelope.payload,
    _envelope: {
      id: envelope.id,
      type: envelope.type,
      version: envelope.version,
      occurred_at: envelope.occurred_at,
      producer: envelope.producer,
      correlation_id: envelope.correlation_id,
      causation_id: envelope.causation_id,
    },
  };
}
