/**
 * Tick3t — secure QR payload helpers.
 * QR contains an opaque token validated only through RedFace backend.
 */

const PREFIX = 'redface:tick3t:v1:';

export function tick3tQrPayload(token: string): string {
  if (token.startsWith(PREFIX)) return token;
  return `${PREFIX}${token}`;
}

export function parseTick3tQr(payload: string): { token: string } | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(PREFIX)) {
    const token = trimmed.slice(PREFIX.length);
    return token ? { token: trimmed } : null;
  }
  return { token: trimmed };
}

export function scanResultLabel(code: string): string {
  switch (code) {
    case 'valid':
      return 'Entry granted';
    case 'already_used':
      return 'Ticket already used';
    case 'invalid_ticket':
      return 'Invalid ticket';
    case 'not_paid':
      return 'Payment not complete';
    case 'cancelled':
      return 'Ticket cancelled';
    case 'expired':
      return 'Ticket expired';
    default:
      return code;
  }
}

export function scanResultTone(code: string): 'success' | 'warning' | 'error' {
  if (code === 'valid') return 'success';
  if (code === 'already_used') return 'warning';
  return 'error';
}
