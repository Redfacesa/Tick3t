import { TICK3T_PLATFORM_ADMIN_EMAILS } from '@/lib/tick3t/admins';

/** Site + RedFace Pay origins for checkout and legal links. */
export const SITE_URL = (
  import.meta.env.VITE_SITE_URL || 'https://tick3t.online'
).replace(/\/$/, '');

export const REDFACE_PAY_ORIGIN = (
  import.meta.env.VITE_REDFACE_PAY_ORIGIN || 'https://www.redfacepay.co.za'
).replace(/\/$/, '');

export const COMPANY_INFO = {
  website: SITE_URL,
  payOrigin: REDFACE_PAY_ORIGIN,
  /** RedFace Pay + Entendre co-owners (Tick3t platform admins). */
  platformAdminEmails: TICK3T_PLATFORM_ADMIN_EMAILS,
  infoEmail: 'info@redfacepay.co.za',
};
