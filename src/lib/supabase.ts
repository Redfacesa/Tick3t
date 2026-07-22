import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isClerkEnabled } from '@/lib/clerkEnabled';

const env = import.meta.env;
const supabaseUrl = (env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
const supabaseKey = (env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';

/** Clerk third-party auth — supabase.auth.* is unavailable when true. */
export const usesThirdPartySupabaseAuth = isClerkEnabled();

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    '[tick3t] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — set them in .env for live data.',
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
  if (usesThirdPartySupabaseAuth) {
    return clerkGetToken ? clerkGetToken() : null;
  }
  if (!supabaseInstance) return null;
  const { data } = await supabaseInstance.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function signOutViaClerk(): Promise<void> {
  if (clerkSignOut) await clerkSignOut();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase: SupabaseClient<any, any, any> = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseKey || 'placeholder',
  usesThirdPartySupabaseAuth
    ? {
        accessToken: getSupabaseAccessToken,
        realtime: { accessToken: getSupabaseAccessToken },
      }
    : {},
);

supabaseInstance = supabase;
