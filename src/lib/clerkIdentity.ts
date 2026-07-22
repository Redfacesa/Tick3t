import { supabase } from '@/lib/supabase';

export type ClerkIdentityLink = {
  supabaseUserId: string;
  clerkUserId: string;
  email: string;
};

/** Ensure Clerk user is linked to a Supabase auth.users row (shared hub edge function). */
export async function ensureClerkIdentityLink(): Promise<ClerkIdentityLink | null> {
  const { data, error } = await supabase.functions.invoke('clerk-link', {
    body: { action: 'ensure' },
  });

  if (error) {
    console.warn('[clerk-link]', error.message);
    return null;
  }

  const body = (data ?? {}) as {
    ok?: boolean;
    supabase_user_id?: string;
    clerk_user_id?: string;
    email?: string;
    message?: string;
  };

  if (!body.ok) {
    console.warn('[clerk-link]', body.message ?? 'link failed');
    return null;
  }

  if (!body.supabase_user_id || !body.email) return null;

  return {
    supabaseUserId: body.supabase_user_id,
    clerkUserId: body.clerk_user_id ?? body.supabase_user_id,
    email: body.email,
  };
}
