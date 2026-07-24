import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSatelliteAccessToken } from '@/lib/satelliteSession';

const env = import.meta.env;
const supabaseUrl = (env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
const supabaseKey = (env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';

/**
 * Tick3t is a Pay satellite. Prefer native setSession when Pay returns access+refresh.
 * When Pay/Clerk returns access_token only, Authorization is injected from satellite storage.
 */
export const usesThirdPartySupabaseAuth = false;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseKey);

if (!hasSupabaseConfig) {
  console.error(
    '[tick3t] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — set them in Vercel (same hub as RedFace Pay).',
  );
}

type TokenGetter = () => Promise<string | null>;
type SignOutFn = () => Promise<void> | void;

let clerkGetToken: TokenGetter | null = null;
let clerkSignOut: SignOutFn | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let supabaseInstance: SupabaseClient<any, any, any> | undefined;

export function registerClerkTokenGetter(getter: TokenGetter | null) {
  clerkGetToken = getter;
}

export function registerClerkSignOut(fn: SignOutFn | null) {
  clerkSignOut = fn;
}

export async function getSupabaseAccessToken(): Promise<string | null> {
  const satellite = getSatelliteAccessToken();
  if (satellite) return satellite;
  if (!supabaseInstance) return null;
  const { data } = await supabaseInstance.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function signOutViaClerk(): Promise<void> {
  if (clerkSignOut) await clerkSignOut();
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function authedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = requestUrl(input);
  const headers = new Headers(init?.headers);

  // Never rewrite GoTrue Authorization — setSession / refresh must own those headers.
  // Interfering here caused "Auth session missing!" during SSO.
  if (!url.includes('/auth/v1/')) {
    const token = await getSupabaseAccessToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  return fetch(input, { ...init, headers });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase: SupabaseClient<any, any, any> = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseKey || 'placeholder',
  {
    global: { fetch: authedFetch },
  },
);

supabaseInstance = supabase;

void clerkGetToken;
