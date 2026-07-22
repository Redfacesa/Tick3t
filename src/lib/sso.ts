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

export const SSO_PARAM_KEYS = [
  'access_token',
  'refresh_token',
  'redface_user_id',
  'email',
  'display_name',
  'merchant_id',
  'display_number',
] as const;

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

/** Remove Pay SSO query params so return_url never nests tokens. */
export function stripSsoParamsFromPath(pathOrUrl: string): string {
  try {
    const base = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${tick3tReturnOrigin()}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
    const u = new URL(base);
    for (const key of SSO_PARAM_KEYS) u.searchParams.delete(key);
    if (pathOrUrl.startsWith('http')) return u.toString();
    return `${u.pathname}${u.search}${u.hash}` || '/';
  } catch {
    return pathOrUrl.split('?')[0] || '/';
  }
}

export function absoluteTick3tReturnUrl(path: string): string {
  const clean = stripSsoParamsFromPath(path);
  const origin = tick3tReturnOrigin().replace(/\/$/, '');
  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    try {
      const u = new URL(clean);
      if (hostAllowed(u.hostname)) return u.toString();
    } catch {
      /* fall through */
    }
    const pathname = clean.replace(/^https?:\/\/[^/]+/i, '') || '/';
    return `${origin}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  }
  return `${origin}${clean.startsWith('/') ? clean : `/${clean}`}`;
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

function readSsoTokens(params: URLSearchParams): { accessToken: string; refreshToken: string } | null {
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

/**
 * Apply access/refresh tokens Pay appends after ecosystem SSO.
 * Also unwraps tokens nested inside ?return_url=… (login bounce).
 */
export async function applyPaySsoTokensFromUrl(): Promise<{ email: string; userId: string } | null> {
  if (typeof window === 'undefined') return null;

  const envUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  const envKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
  if (!envUrl || !envKey) {
    console.error(
      '[tick3t] SSO cannot complete — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel.',
    );
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  let tokens = readSsoTokens(params);
  let nestedReturn: URL | null = null;

  if (!tokens) {
    const nested = params.get('return_url');
    if (nested) {
      try {
        const nestedUrl = new URL(nested, window.location.origin);
        tokens = readSsoTokens(nestedUrl.searchParams);
        if (tokens) nestedReturn = nestedUrl;
      } catch {
        /* ignore */
      }
    }
  }

  if (!tokens) return null;

  const { data, error } = await supabase.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });

  if (error || !data.session?.user) {
    console.error('[tick3t] SSO setSession failed', error?.message || 'no session');
    return null;
  }

  // Clean URL: drop SSO params (and unwrap nested return_url bounce).
  if (nestedReturn) {
    for (const key of SSO_PARAM_KEYS) nestedReturn.searchParams.delete(key);
    const clean =
      nestedReturn.origin === window.location.origin
        ? `${nestedReturn.pathname}${nestedReturn.search}${nestedReturn.hash}`
        : nestedReturn.toString();
    window.history.replaceState({}, '', clean || '/');
  } else {
    for (const key of SSO_PARAM_KEYS) params.delete(key);
    const clean = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${clean ? `?${clean}` : ''}`);
  }

  return {
    email: data.session.user.email || params.get('email') || nestedReturn?.searchParams.get('email') || '',
    userId: data.session.user.id,
  };
}
