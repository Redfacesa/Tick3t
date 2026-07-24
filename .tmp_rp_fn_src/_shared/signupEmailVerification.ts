import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TOKEN_TTL_HOURS = 24;
const RESEND_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_RESENDS_PER_DAY = 5;

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function appOrigin(): string {
  return (Deno.env.get('APP_URL') ?? 'https://www.redfacepay.co.za').replace(/\/$/, '');
}

async function nudgeNotificationService(): Promise<void> {
  const url = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/notification-service`;
  const secret = Deno.env.get('CRON_SECRET') ?? '';
  if (!url || !secret) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': secret,
      },
      body: JSON.stringify({ action: 'process_outbox', limit: 10 }),
    });
  } catch {
    /* cron will retry */
  }
}

export async function sendSignupVerificationEmail(
  admin: SupabaseClient,
  rawEmail: string,
): Promise<{ ok: boolean; message: string; alreadyVerified?: boolean }> {
  const email = rawEmail.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return { ok: false, message: 'Enter a valid email address.' };
  }

  const { data: verified } = await admin.rpc('is_signup_email_verified', { p_email: email });
  if (verified) {
    return { ok: true, message: 'Email already verified. You can sign in.', alreadyVerified: true };
  }

  const { data: existing } = await admin
    .from('user_signup_email_verifications')
    .select('email, resent_count, last_sent_at, verified_at')
    .eq('email', email)
    .maybeSingle();

  if (existing?.verified_at) {
    return { ok: true, message: 'Email already verified. You can sign in.', alreadyVerified: true };
  }

  const now = Date.now();
  if (existing?.last_sent_at) {
    const lastSent = new Date(String(existing.last_sent_at)).getTime();
    if (now - lastSent < RESEND_COOLDOWN_MS) {
      return {
        ok: true,
        message: 'Verification email already sent. Check your inbox (and spam), or wait a few minutes to resend.',
      };
    }
    if (Number(existing.resent_count ?? 0) >= MAX_RESENDS_PER_DAY) {
      return { ok: false, message: 'Too many verification emails today. Try again tomorrow or contact support.' };
    }
  }

  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(now + TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const verifyUrl = `${appOrigin()}/verify-email?token=${encodeURIComponent(token)}`;
  const loginUrl = `${appOrigin()}/login`;

  const { error: upsertErr } = await admin.from('user_signup_email_verifications').upsert({
    email,
    token_hash: tokenHash,
    expires_at: expiresAt,
    verified_at: null,
    resent_count: Number(existing?.resent_count ?? 0) + (existing ? 1 : 0),
    last_sent_at: new Date().toISOString(),
  });
  if (upsertErr) {
    return { ok: false, message: 'Could not start verification. Try again.' };
  }

  const body = [
    'Welcome to RedFace Pay!',
    '',
    'Verify your email to activate your account:',
    verifyUrl,
    '',
    `This link expires in ${TOKEN_TTL_HOURS} hours.`,
    '',
    `After verifying, sign in here: ${loginUrl}`,
    '',
    'If you did not create a RedFace account, you can ignore this email.',
  ].join('\n');

  await admin.rpc('enqueue_platform_notification', {
    p_channel: 'email',
    p_recipient: email,
    p_event_type: 'signup_verification',
    p_body: body,
    p_payload: { verify_url: verifyUrl, login_url: loginUrl },
    p_subject: 'Verify your RedFace Pay email',
    p_reference: `signup_verify:${email}`,
  }).then(() => {}, () => {});

  void nudgeNotificationService();

  return {
    ok: true,
    message: 'Verification email sent. Check your inbox, then sign in after you verify.',
  };
}
