import { SITE_URL, REDFACE_PAY_ORIGIN } from '@/lib/company';
import { supabase } from '@/lib/supabase';

/** Hosts RedFace Pay allows for satellite return_url (ecosystem SSO). */
const TICK3T_ALLOWED_HOSTS = new Set([
  'tick3t.online',
  'www.tick3t.online',
  'tick3t.vercel.app',
  'localhost',
  '127.0.0.1',
]);

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (TICK3T_ALLOWED_HOSTS.has(host)) return true;
  if (host.endsWith('.tick3t.online')) return true;
  if (host.endsWith('.vercel.app')) return true;
  return false;
}

/**
 * Absolute return URL for Pay ecosystem login.
 * Prefers current origin when allowed; otherwise canonical SITE_URL.
 */
export function tick3tReturnOrigin(): string {
  if (typeof window !== 'undefined') {
    const { protocol, hostname, origin } = window.location;
    const okProtocol = protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1';
    if (okProtocol && hostAllowed(hostname)) return origin;
  }
  return SITE_URL.replace(/\/$/, '') || 'https://www.tick3t.online';
}

export function absoluteTick3tReturnUrl(path: string): string {
  const origin = tick3tReturnOrigin().replace(/\/$/, '');
  if (path.startsWith('http://') || path.startsWith('https://')) {
    try {
      const u = new URL(path);
      if (hostAllowed(u.hostname)) return u.toString();
    } catch {
      /* fall through */
    }
    const pathname = path.replace(/^https?:\/\/[^/]+/i, '') || '/';
    return `${origin}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  }
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/** RedFace Pay ecosystem login — never send relative return_url. */
export function buildPayEcosystemLoginUrl(returnPath: string, role = 'customer'): string {
  const returnUrl = absoluteTick3tReturnUrl(returnPath);
  const q = new URLSearchParams({
    ecosystem_from: 'tick3t',
    return_url: returnUrl,
    role,
  });
  return `${REDFACE_PAY_ORIGIN}/ecosystem/login?${q.toString()}`;
}

/** Apply access/refresh tokens Pay appends after ecosystem SSO. */
export async function applyPaySsoTokensFromUrl(): Promise<{ email: string; userId: string } | null> {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;

  const { data, error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error || !data.session?.user) return null;

  for (const key of [
    'access_token',
    'refresh_token',
    'redface_user_id',
    'email',
    'display_name',
    'merchant_id',
    'display_number',
  ]) {
    params.delete(key);
  }
  const clean = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${clean ? `?${clean}` : ''}`);

  return {
    email: data.session.user.email || '',
    userId: data.session.user.id,
  };
}
