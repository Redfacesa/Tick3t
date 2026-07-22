import { describe, expect, it } from 'vitest';
import { parseTick3tQr, scanResultLabel, scanResultTone, tick3tQrPayload } from '@/lib/tick3t/qr';

describe('tick3t QR helpers', () => {
  it('builds opaque v1 payload', () => {
    const token = 'abc123';
    expect(tick3tQrPayload(token)).toBe('redface:tick3t:v1:abc123');
  });

  it('parses full payload', () => {
    const payload = 'redface:tick3t:v1:opaque-token';
    expect(parseTick3tQr(payload)).toEqual({ token: payload });
  });

  it('parses raw ticket code fallback', () => {
    expect(parseTick3tQr('ENT-AB12CD34')).toEqual({ token: 'ENT-AB12CD34' });
  });

  it('maps scan result labels', () => {
    expect(scanResultLabel('valid')).toBe('Entry granted');
    expect(scanResultLabel('already_used')).toBe('Ticket already used');
    expect(scanResultLabel('invalid_ticket')).toBe('Invalid ticket');
  });

  it('maps scan result tones', () => {
    expect(scanResultTone('valid')).toBe('success');
    expect(scanResultTone('already_used')).toBe('warning');
    expect(scanResultTone('invalid_ticket')).toBe('error');
  });
});
