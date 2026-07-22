import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const env = import.meta.env;
const supabaseUrl = (env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
const supabaseKey = (env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';

/**
 * Tick3t is a Pay satellite: identity comes from RedFace Pay ecosystem SSO
 * (supabase setSession). Do not wire Clerk as Supabase third-party auth here —
 * that blocks Pay return tokens from establishing a session.
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
);

supabaseInstance = supabase;

// Keep getters referenced so Clerk bridge can still register without enabling third-party mode.
void clerkGetToken;
