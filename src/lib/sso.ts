import { SITE_URL, REDFACE_PAY_ORIGIN } from '@/lib/company';
import { setSatelliteSession } from '@/lib/satelliteSession';
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
    u.hash = '';
    if (pathOrUrl.startsWith('http')) return u.toString();
    return `${u.pathname}${u.search}${u.hash}` || '/';
  } catch {
    return pathOrUrl.split('?')[0]?.split('#')[0] || '/';
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

function readSsoParams(params: URLSearchParams): {
  accessToken: string | null;
  refreshToken: string | null;
  email: string;
  userId: string;
} {
  return {
    accessToken: params.get('access_token'),
    refreshToken: params.get('refresh_token'),
    email: (params.get('email') || '').trim().toLowerCase(),
    userId: (params.get('redface_user_id') || '').trim(),
  };
}

/** Merge query + hash SSO params (Pay now prefers hash for long JWTs). */
function readSsoFromLocation(): {
  accessToken: string | null;
  refreshToken: string | null;
  email: string;
  userId: string;
} {
  const query = new URLSearchParams(window.location.search);
  const hashRaw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const hash = new URLSearchParams(hashRaw);

  const fromQuery = readSsoParams(query);
  const fromHash = readSsoParams(hash);

  return {
    accessToken: fromHash.accessToken || fromQuery.accessToken,
    refreshToken: fromHash.refreshToken || fromQuery.refreshToken,
    email: fromHash.email || fromQuery.email,
    userId: fromHash.userId || fromQuery.userId,
  };
}

function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function cleanUrlAfterSso() {
  const params = new URLSearchParams(window.location.search);
  for (const key of SSO_PARAM_KEYS) params.delete(key);
  const clean = params.toString();
  window.history.replaceState(
    {},
    '',
    `${window.location.pathname}${clean ? `?${clean}` : ''}`,
  );
}

/**
 * Apply access/refresh tokens Pay appends after ecosystem SSO.
 * Supports:
 * - Native Supabase pair (access + refresh) via setSession
 * - Clerk/Pay access_token-only via satellite session storage (fixes sell-login loop)
 * Tokens may arrive in the hash (preferred) or query (legacy).
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

  let sso = readSsoFromLocation();

  // Legacy: tokens nested inside return_url query
  if (!sso.accessToken) {
    const nested = new URLSearchParams(window.location.search).get('return_url');
    if (nested) {
      try {
        const nestedUrl = new URL(nested, window.location.origin);
        const nestedHash = new URLSearchParams(
          nestedUrl.hash.startsWith('#') ? nestedUrl.hash.slice(1) : nestedUrl.hash,
        );
        const nestedSso = {
          ...readSsoParams(nestedUrl.searchParams),
          accessToken:
            readSsoParams(nestedHash).accessToken || readSsoParams(nestedUrl.searchParams).accessToken,
          refreshToken:
            readSsoParams(nestedHash).refreshToken || readSsoParams(nestedUrl.searchParams).refreshToken,
          email: readSsoParams(nestedHash).email || readSsoParams(nestedUrl.searchParams).email,
          userId: readSsoParams(nestedHash).userId || readSsoParams(nestedUrl.searchParams).userId,
        };
        if (nestedSso.accessToken) sso = nestedSso;
      } catch {
        /* ignore */
      }
    }
  }

  if (!sso.accessToken) return null;

  if (!looksLikeJwt(sso.accessToken)) {
    console.error(
      '[tick3t] SSO access_token is truncated or invalid (not a JWT). Sign in again from RedFace Pay.',
    );
    cleanUrlAfterSso();
    return null;
  }

  // Preferred: full Supabase session from Pay (non-Clerk).
  if (sso.refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: sso.accessToken,
      refresh_token: sso.refreshToken,
    });
    if (!error && data.session?.user) {
      cleanUrlAfterSso();
      return {
        email: data.session.user.email || sso.email,
        userId: data.session.user.id,
      };
    }
    console.warn(
      '[tick3t] SSO setSession failed — falling back to access-token satellite mode',
      error?.message,
    );
  }

  // Clerk-on-Pay path: only access_token (+ email / user id) is returned.
  const email = sso.email || '';
  const userId = sso.userId || '';
  if (!email) {
    console.error('[tick3t] SSO access_token present but email missing — cannot establish identity');
    cleanUrlAfterSso();
    return null;
  }

  setSatelliteSession({
    accessToken: sso.accessToken,
    email,
    userId: userId || email,
  });
  cleanUrlAfterSso();

  return { email, userId: userId || email };
}
