import { describe, expect, it } from 'vitest';
import { isTick3tPlatformAdminEmail, TICK3T_PLATFORM_ADMIN_EMAILS } from '@/lib/tick3t/admins';

describe('Tick3t platform admins', () => {
  it('lists RedFace Pay and Entendre co-owners', () => {
    expect(TICK3T_PLATFORM_ADMIN_EMAILS).toEqual([
      'info@redfacepay.co.za',
      '3ntendr3@gmail.com',
    ]);
  });

  it('matches co-owner emails case-insensitively', () => {
    expect(isTick3tPlatformAdminEmail('info@redfacepay.co.za')).toBe(true);
    expect(isTick3tPlatformAdminEmail('3ntendr3@gmail.com')).toBe(true);
    expect(isTick3tPlatformAdminEmail('Info@RedFacePay.co.za')).toBe(true);
    expect(isTick3tPlatformAdminEmail('someone@else.com')).toBe(false);
    expect(isTick3tPlatformAdminEmail(null)).toBe(false);
  });
});
