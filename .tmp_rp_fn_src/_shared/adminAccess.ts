import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** Env fallback when admins table is empty (comma-separated). */
export function adminEmailAllowList(): string[] {
  return (Deno.env.get('ADMIN_EMAILS') ?? 'info@redfacepay.co.za')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** True if email is in public.admins or ADMIN_EMAILS env fallback. */
export async function isAdminEmail(
  admin: SupabaseClient,
  email: string | null | undefined,
): Promise<boolean> {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) return false;

  const { data, error } = await admin
    .from('admins')
    .select('email')
    .ilike('email', normalized)
    .maybeSingle();

  if (!error && data?.email) return true;
  return adminEmailAllowList().includes(normalized);
}

export async function requireAdminFromRequest(
  admin: SupabaseClient,
  req: Request,
): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) return null;
  return (await isAdminEmail(admin, email)) ? email : null;
}

export function authorizeCron(req: Request): boolean {
  const secret = Deno.env.get('CRON_SECRET') ?? '';
  if (!secret) return false;
  const h = req.headers.get('x-cron-secret')
    ?? (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  return h === secret;
}
