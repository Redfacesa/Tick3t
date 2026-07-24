/** Boss / platform alert emails — best-effort, never throws. */

import { DEFAULT_NOTIFY_FROM, DEFAULT_NOTIFY_TO, DEFAULT_BOSS_EMAIL } from './platformEmail.ts';

export type BossEvent =
  | 'user_signup'
  | 'merchant_application'
  | 'payment_failed'
  | 'transfer_failed'
  | 'webhook_error'
  | 'client_error';

/** Distinct inbox addresses (BOSS_EMAIL + NOTIFY_TO). */
export function bossRecipients(): string[] {
  const out = new Set<string>();
  const boss = Deno.env.get('BOSS_EMAIL')?.trim().toLowerCase() ?? DEFAULT_BOSS_EMAIL.toLowerCase();
  const notify = (Deno.env.get('NOTIFY_TO') ?? DEFAULT_NOTIFY_TO).trim().toLowerCase();
  if (boss) out.add(boss);
  if (notify) out.add(notify);
  return [...out];
}

async function sendOne(
  resendKey: string,
  from: string,
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!res.ok) {
      console.error('[bossNotify] resend failed', to, res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('[bossNotify] send error', to, err);
    return false;
  }
}

export async function notifyBoss(opts: {
  subject: string;
  html: string;
  from?: string;
}): Promise<boolean> {
  const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
  const from = opts.from ?? Deno.env.get('NOTIFY_FROM') ?? DEFAULT_NOTIFY_FROM;
  const recipients = bossRecipients();
  if (!resendKey || recipients.length === 0) return false;

  let any = false;
  for (const to of recipients) {
    if (await sendOne(resendKey, from, to, opts.subject, opts.html)) any = true;
  }
  return any;
}

export function bossAlertHtml(event: BossEvent, lines: Record<string, string>): string {
  const rows = Object.entries(lines)
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;">${k}</td><td><strong>${v}</strong></td></tr>`)
    .join('');
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
      <p style="color:#FF4B4B;font-weight:bold;margin:0 0 8px;">RedFace Pay alert · ${event}</p>
      <table style="font-size:14px;border-collapse:collapse;">${rows}</table>
      <p style="font-size:12px;color:#888;margin-top:16px;">${new Date().toISOString()}</p>
    </div>
  `.trim();
}
