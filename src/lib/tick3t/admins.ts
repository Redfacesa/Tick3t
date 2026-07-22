/**
 * Tick3t platform co-owners (RedFace Pay + Entendre).
 * Must stay in sync with hub `platform_ecosystem_apps.admin_emails`
 * for slugs `tick3t` and `entendre` (see Redface-pay migrations 0323/0324).
 */
export const TICK3T_PLATFORM_ADMIN_EMAILS = [
  'info@redfacepay.co.za', // RedFace Pay
  '3ntendr3@gmail.com', // Entendre
] as const;

export type Tick3tPlatformAdminEmail = (typeof TICK3T_PLATFORM_ADMIN_EMAILS)[number];

export function isTick3tPlatformAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return (TICK3T_PLATFORM_ADMIN_EMAILS as readonly string[]).includes(normalized);
}
