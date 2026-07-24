import type { VerifyTransactionResult } from './types.ts';

/**
 * Legacy Paystack verify envelope still expected by redface-pay confirm paths.
 * Maps PaymentProvider.verifyTransaction → { status, data, message }.
 */
export function verifyResultToLegacyEnvelope(result: VerifyTransactionResult): Record<string, unknown> {
  return {
    status: result.ok,
    message: result.message,
    data: {
      status: result.status,
      amount: result.amountSubunits,
      currency: result.currency,
      metadata: result.metadata ?? {},
    },
  };
}
