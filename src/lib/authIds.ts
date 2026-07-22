const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when id is a Supabase Auth UUID (not a Clerk `user_…` subject). */
export function isSupabaseAuthUserId(id: string | undefined | null): boolean {
  return !!id && UUID_RE.test(id);
}
