/** Default platform email addresses (override via NOTIFY_FROM / NOTIFY_TO secrets). */

export const PLATFORM_INFO_EMAIL = 'info@redfacepay.co.za';

/** Personal boss inbox — set BOSS_EMAIL secret (e.g. redfacesa@gmail.com). */
export const DEFAULT_BOSS_EMAIL = 'redfacesa@gmail.com';

export const DEFAULT_NOTIFY_FROM = `RedFace Pay <${PLATFORM_INFO_EMAIL}>`;

export const DEFAULT_NOTIFY_TO = PLATFORM_INFO_EMAIL;
