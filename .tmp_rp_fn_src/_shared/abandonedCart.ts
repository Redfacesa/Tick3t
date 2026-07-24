import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
import { DEFAULT_NOTIFY_FROM } from './platformEmail.ts';

const NOTIFY_FROM = Deno.env.get('NOTIFY_FROM') ?? DEFAULT_NOTIFY_FROM;
const APP_URL = Deno.env.get('APP_URL') ?? 'https://redfacepay.co.za';
const REMINDER_AFTER_HOURS = Number(Deno.env.get('ABANDONED_CART_REMINDER_HOURS') ?? '24');

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY || !to) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: NOTIFY_FROM, to: [to], subject, html }),
  });
  return res.ok;
}

export async function markAbandonedCartRecovered(
  admin: SupabaseClient,
  merchantId: string,
  buyerEmail: string,
) {
  const email = buyerEmail.toLowerCase().trim();
  if (!email || !merchantId) return;
  await admin
    .from('merchant_abandoned_carts')
    .update({
      status: 'recovered',
      recovered_at: new Date().toISOString(),
    })
    .eq('merchant_id', merchantId)
    .eq('buyer_email', email)
    .eq('status', 'active');
}

export async function processAbandonedCartReminders(admin: SupabaseClient): Promise<{
  sent: number;
  expired: number;
}> {
  const cutoff = new Date(Date.now() - REMINDER_AFTER_HOURS * 3600000).toISOString();
  const expireBefore = new Date(Date.now() - 30 * 86400000).toISOString();

  const { data: expiredRows } = await admin
    .from('merchant_abandoned_carts')
    .update({ status: 'expired' })
    .eq('status', 'active')
    .lt('updated_at', expireBefore)
    .select('id');

  const expired = expiredRows?.length ?? 0;

  const { data: rows } = await admin
    .from('merchant_abandoned_carts')
    .select('id, buyer_email, subtotal, currency, recovery_token, merchant_id, item_count')
    .eq('status', 'active')
    .is('reminder_sent_at', null)
    .lt('updated_at', cutoff)
    .limit(50);

  let sent = 0;
  for (const row of rows || []) {
    const { data: merchant } = await admin
      .from('merchants')
      .select('business_name')
      .eq('id', row.merchant_id)
      .maybeSingle();
    const name = merchant?.business_name || 'your seller';
    const recoveryUrl = `${APP_URL}/?view=cart&recover=${row.recovery_token}`;
    const amount = Number(row.subtotal).toFixed(2);
    const ccy = row.currency || 'ZAR';

    const ok = await sendEmail(
      row.buyer_email,
      `Complete your order at ${name}`,
      `<p>You left ${row.item_count} item(s) in your cart at <strong>${name}</strong> (${ccy} ${amount}).</p>
       <p><a href="${recoveryUrl}">Return to checkout</a> to complete your purchase.</p>
       <p style="color:#888;font-size:12px">If you already paid, you can ignore this email.</p>`,
    );

    if (ok) {
      await admin
        .from('merchant_abandoned_carts')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('id', row.id);
      sent++;
    }
  }

  return { sent, expired };
}
