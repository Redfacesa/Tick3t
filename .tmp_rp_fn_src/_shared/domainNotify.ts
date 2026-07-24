// Domain purchase emails (Resend). Best-effort — never blocks registration.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { DEFAULT_NOTIFY_FROM, DEFAULT_NOTIFY_TO } from './platformEmail.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const NOTIFY_FROM = Deno.env.get('NOTIFY_FROM') ?? DEFAULT_NOTIFY_FROM;
const APP_URL = Deno.env.get('APP_URL') ?? 'https://redfacepay.co.za';
const NOTIFY_TO = Deno.env.get('NOTIFY_TO') ?? DEFAULT_NOTIFY_TO;

async function send(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY || !to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: NOTIFY_FROM, to: [to], subject, html }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function emailDomainRegistrationQueued(to: string, domainName: string): Promise<boolean> {
  return send(
    to,
    `We're registering ${domainName}`,
    `<div style="font-family:sans-serif;max-width:560px;color:#1a1a1a;">
      <h2 style="margin:0 0 12px;">Your payment was received</h2>
      <p>Thanks for buying <strong>${domainName}</strong> on RedFace Pay.</p>
      <p>We're registering this name for you now. This usually takes a few minutes. If our registrar is briefly unavailable, we'll keep trying automatically — you don't need to pay again.</p>
      <p>You'll receive another email when <strong>${domainName}</strong> is active in your account.</p>
      <p style="margin-top:24px;font-size:13px;color:#666;">View your domains: <a href="${APP_URL}?view=domains">${APP_URL}</a></p>
    </div>`,
  );
}

export async function emailDomainRegistrationComplete(to: string, domainName: string): Promise<boolean> {
  return send(
    to,
    `${domainName} is now yours`,
    `<div style="font-family:sans-serif;max-width:560px;color:#1a1a1a;">
      <h2 style="margin:0 0 12px;">Domain registered</h2>
      <p><strong>${domainName}</strong> is now registered and linked to your RedFace Pay account.</p>
      <p>Sign in to connect it to a store or manage DNS.</p>
      <p style="margin-top:24px;font-size:13px;color:#666;"><a href="${APP_URL}?view=domains">Open my domains</a></p>
    </div>`,
  );
}

export async function emailDomainRenewalComplete(to: string, domainName: string, expiryDate: string): Promise<boolean> {
  const exp = new Date(expiryDate).toLocaleDateString('en-ZA', { dateStyle: 'long' });
  return send(
    to,
    `${domainName} renewed successfully`,
    `<div style="font-family:sans-serif;max-width:560px;color:#1a1a1a;">
      <h2 style="margin:0 0 12px;">Domain renewed</h2>
      <p><strong>${domainName}</strong> has been renewed on your RedFace Pay account.</p>
      <p>New expiry date: <strong>${exp}</strong></p>
      <p style="margin-top:24px;font-size:13px;color:#666;"><a href="${APP_URL}?view=domains">Manage my domains</a></p>
    </div>`,
  );
}

export async function emailDomainRenewalReminder(
  to: string,
  domainName: string,
  expiryDate: string,
  daysLeft: number,
): Promise<boolean> {
  const exp = new Date(expiryDate).toLocaleDateString('en-ZA', { dateStyle: 'long' });
  return send(
    to,
    `${domainName} expires in ${daysLeft} days`,
    `<div style="font-family:sans-serif;max-width:560px;color:#1a1a1a;">
      <h2 style="margin:0 0 12px;">Renew your domain</h2>
      <p><strong>${domainName}</strong> expires on <strong>${exp}</strong> (${daysLeft} days).</p>
      <p>Auto-renew is off for this domain. Renew now in RedFace Pay to keep your website and email DNS working.</p>
      <p style="margin-top:24px;font-size:13px;color:#666;"><a href="${APP_URL}?view=domains">Renew in my account</a></p>
    </div>`,
  );
}

export async function emailDomainAutoRenewFailed(to: string, domainName: string, reason: string): Promise<boolean> {
  return send(
    to,
    `Could not auto-renew ${domainName}`,
    `<div style="font-family:sans-serif;max-width:560px;color:#1a1a1a;">
      <h2 style="margin:0 0 12px;">Auto-renew payment failed</h2>
      <p>We could not charge your saved card to renew <strong>${domainName}</strong>.</p>
      <p><strong>Reason:</strong> ${reason}</p>
      <p>Please renew manually in your account before the domain expires.</p>
      <p style="margin-top:24px;font-size:13px;color:#666;"><a href="${APP_URL}?view=domains">Open my domains</a></p>
    </div>`,
  );
}

export async function notifyAdminDomainPending(
  admin: SupabaseClient,
  domainName: string,
  reason: string,
  merchantId: string | null,
): Promise<void> {
  try {
    await admin.from('admin_notifications').insert({
      type: 'domain_registration_pending',
      title: `Paid domain awaiting registration: ${domainName}`,
      body: reason,
      merchant_id: merchantId,
    });
  } catch {
    // duplicate or RLS — non-fatal
  }
  await send(
    NOTIFY_TO,
    `Domain registration pending: ${domainName}`,
    `<p>Customer paid for <strong>${domainName}</strong> but name.com registration did not complete.</p>
     <p><strong>Reason:</strong> ${reason}</p>
     <p>Top up name.com credit if needed — registration retries automatically when customers refresh, or use Admin → Domain queue.</p>`,
  );
}
