import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PLATFORM_OWNER_EMAIL = 'info@redfacepay.co.za';

export function isPlatformOwnerEmail(email: string | null | undefined): boolean {
  return String(email ?? '').trim().toLowerCase() === PLATFORM_OWNER_EMAIL;
}

export type MerchantAutoApproveRow = {
  id: string;
  status: string;
  business_name: string | null;
  email: string | null;
  owner_name: string | null;
  account_name: string | null;
  account_verified: boolean | null;
  account_verified_by: string | null;
  bank_code: string | null;
  bank_account: string | null;
  kyc_doc: string | null;
  legal_status: string | null;
  permit_number: string | null;
  sells_restricted_goods: boolean | null;
  paystack_subaccount: string | null;
};

export type AutoApproveAssessment = {
  eligible: boolean;
  blockers: string[];
  reasons: string[];
};

function normalizeNamePart(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(pty|ltd|cc|inc|npc|npo|trust)\b/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Loose match — bank account holder vs business or owner name. */
export function bankAccountNameAligns(
  accountName: string | null | undefined,
  businessName: string | null | undefined,
  ownerName: string | null | undefined,
): boolean {
  const account = normalizeNamePart(String(accountName ?? ''));
  if (!account) return true;
  const business = normalizeNamePart(String(businessName ?? ''));
  const owner = normalizeNamePart(String(ownerName ?? ''));
  if (business && (account.includes(business) || business.includes(account))) return true;
  if (owner && (account.includes(owner) || owner.includes(account))) return true;
  const ownerParts = owner.split(' ').filter((p) => p.length > 2);
  if (ownerParts.some((p) => account.includes(p))) return true;
  return false;
}

export function assessMerchantForAutoApprove(
  m: MerchantAutoApproveRow,
  identityDocCount: number,
): AutoApproveAssessment {
  const blockers: string[] = [];
  const reasons: string[] = [];

  if (m.status !== 'pending') blockers.push('already_reviewed');
  if (!m.account_verified) blockers.push('bank_not_verified');
  if (!m.bank_code?.trim() || !m.bank_account?.trim()) blockers.push('bank_incomplete');
  if (!m.kyc_doc?.trim() && identityDocCount < 1) blockers.push('identity_docs_missing');
  if (!m.business_name?.trim()) blockers.push('business_name_missing');
  if (!m.owner_name?.trim()) blockers.push('owner_name_missing');
  if (!m.email?.trim()) blockers.push('email_missing');
  if (m.sells_restricted_goods) blockers.push('restricted_goods_review');

  if (['foreign_national', 'refugee_asylum'].includes(String(m.legal_status ?? '')) && !m.permit_number?.trim()) {
    blockers.push('permit_required');
  }

  if (m.account_verified && m.account_verified_by === 'admin') {
    reasons.push('bank_verified_by_admin');
  } else if (m.account_verified) {
    reasons.push('bank_verified_paystack');
  }

  if (m.kyc_doc?.trim() || identityDocCount > 0) reasons.push('identity_on_file');

  if (
    m.account_name?.trim()
    && !bankAccountNameAligns(m.account_name, m.business_name, m.owner_name)
  ) {
    blockers.push('account_name_mismatch');
  } else if (m.account_name?.trim()) {
    reasons.push('account_name_matches_business');
  }

  return { eligible: blockers.length === 0, blockers, reasons };
}

export type ProvisionResult = {
  ok: boolean;
  message?: string;
  subaccount?: string | null;
  tag_code?: string | null;
  already_approved?: boolean;
};

export async function provisionMerchantPayouts(
  admin: SupabaseClient,
  paystackPost: (path: string, body: unknown) => Promise<Record<string, unknown>>,
  opts: {
    merchantId: string;
    actorEmail?: string | null;
    decisionReason?: string;
    decisionNotes?: string | null;
    manualSubaccountCode?: string;
    platformFeePercent: number;
    sendWelcomeEmail: (args: {
      email: string;
      businessName: string;
      tagCode: string;
    }) => Promise<void>;
  },
): Promise<ProvisionResult> {
  const merchantId = opts.merchantId;
  const { data: merchant } = await admin
    .from('merchants')
    .select(
      'id, business_name, email, bank_code, bank_account, paystack_subaccount, status, legal_status, permit_number, permit_expiry, offering_type, primary_products, expected_monthly_volume, sells_restricted_goods, risk_level, account_verified',
    )
    .eq('id', merchantId)
    .maybeSingle();

  if (!merchant) return { ok: false, message: 'Merchant not found' };

  const existingRoute = String(merchant.paystack_subaccount ?? '').trim();
  const hasLiveRoute = existingRoute.startsWith('ACCT_') || existingRoute.startsWith('SPL_');

  // Already approved with a real settlement route — idempotent success.
  if (merchant.status === 'approved' && hasLiveRoute) {
    return { ok: true, already_approved: true, subaccount: existingRoute };
  }

  // Platform owner settles on the main Paystack account — never create a subaccount.
  if (isPlatformOwnerEmail(String(merchant.email ?? ''))) {
    const { data: existingTag } = await admin
      .from('nfc_tags')
      .select('tag_code')
      .eq('merchant_id', merchantId)
      .maybeSingle();
    const tagCode = existingTag?.tag_code ?? `RFP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    await admin
      .from('merchants')
      .update({
        paystack_subaccount: null,
        paystack_split_code: null,
        status: 'approved',
        account_verified: true,
        account_verified_by: merchant.account_verified_by ?? 'admin',
      })
      .eq('id', merchantId);

    if (!existingTag) {
      await admin.from('nfc_tags').insert({ merchant_id: merchantId, tag_code: tagCode, status: 'active' });
    }

    await admin.from('admin_actions').insert({
      action_type: opts.actorEmail ? 'approve_merchant' : 'auto_approve_merchant',
      merchant_id: merchantId,
      actor_email: opts.actorEmail ?? null,
      decision_reason: opts.decisionReason || 'Platform owner — main Paystack account (no subaccount)',
      decision_notes: opts.decisionNotes ?? null,
      compliance_snapshot: {
        platform_owner: true,
        paystack_subaccount: null,
        auto: !opts.actorEmail,
      },
    });

    if (merchant.email) {
      await opts.sendWelcomeEmail({
        email: String(merchant.email),
        businessName: String(merchant.business_name),
        tagCode,
      });
    }

    return { ok: true, subaccount: null, tag_code: tagCode };
  }

  const manualCode = String(opts.manualSubaccountCode ?? '').trim();
  const existingCode = (merchant.paystack_subaccount as string | null) || '';
  let subaccountCode: string | null =
    manualCode ||
    (existingCode.startsWith('ACCT_') || existingCode.startsWith('SPL_') ? existingCode : null);

  if (!subaccountCode) {
    if (!merchant.bank_code || !merchant.bank_account) {
      return {
        ok: false,
        message: 'Verified bank details are required before payouts can go live.',
      };
    }
    const ps = await paystackPost('/subaccount', {
      business_name: merchant.business_name,
      settlement_bank: merchant.bank_code,
      account_number: merchant.bank_account,
      percentage_charge: opts.platformFeePercent,
    });
    if (!ps?.status) {
      return { ok: false, message: String(ps?.message || 'Paystack rejected subaccount creation') };
    }
    subaccountCode = (ps.data as { subaccount_code?: string })?.subaccount_code ?? null;
  }

  if (!subaccountCode) {
    return { ok: false, message: 'Could not determine a Paystack subaccount code' };
  }

  const { data: existingTag } = await admin
    .from('nfc_tags')
    .select('tag_code')
    .eq('merchant_id', merchantId)
    .maybeSingle();
  const tagCode = existingTag?.tag_code ?? `RFP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  await admin
    .from('merchants')
    .update({ paystack_subaccount: subaccountCode, status: 'approved' })
    .eq('id', merchantId);

  // Off Menu shares this merchants row — keep application queue + public profile in sync.
  await admin
    .from('off_menu_vendor_applications')
    .update({ status: 'approved', updated_at: new Date().toISOString() })
    .eq('merchant_id', merchantId)
    .in('status', ['pending', 'submitted']);
  await admin
    .from('merchants')
    .update({ profile_public: true })
    .eq('id', merchantId)
    .eq('signup_vertical', 'off_menu');

  if (!existingTag) {
    await admin.from('nfc_tags').insert({ merchant_id: merchantId, tag_code: tagCode, status: 'active' });
  }

  await admin.from('admin_actions').insert({
    action_type: opts.actorEmail ? 'approve_merchant' : 'auto_approve_merchant',
    merchant_id: merchantId,
    actor_email: opts.actorEmail ?? null,
    decision_reason: opts.decisionReason || 'Automated approval after bank and business verification',
    decision_notes: opts.decisionNotes ?? null,
    compliance_snapshot: {
      legal_status: merchant.legal_status,
      permit_number: merchant.permit_number,
      permit_expiry: merchant.permit_expiry,
      offering_type: merchant.offering_type,
      primary_products: merchant.primary_products,
      expected_monthly_volume: merchant.expected_monthly_volume,
      sells_restricted_goods: merchant.sells_restricted_goods,
      risk_level: merchant.risk_level,
      account_verified: merchant.account_verified,
      subaccount_code: subaccountCode,
      auto: !opts.actorEmail,
    },
  });

  if (merchant.email) {
    await opts.sendWelcomeEmail({
      email: String(merchant.email),
      businessName: String(merchant.business_name),
      tagCode,
    });
  }

  return { ok: true, subaccount: subaccountCode, tag_code: tagCode };
}

export async function tryAutoApproveMerchant(
  admin: SupabaseClient,
  paystackPost: (path: string, body: unknown) => Promise<Record<string, unknown>>,
  opts: {
    merchantId: string;
    platformFeePercent: number;
    appUrl: string;
    sendWelcomeEmail: (args: {
      email: string;
      businessName: string;
      tagCode: string;
    }) => Promise<void>;
  },
): Promise<{ approved: boolean; blockers?: string[]; subaccount?: string | null }> {
  const { data: merchant } = await admin
    .from('merchants')
    .select(
      'id, status, business_name, email, owner_name, account_name, account_verified, account_verified_by, bank_code, bank_account, kyc_doc, legal_status, permit_number, sells_restricted_goods, paystack_subaccount',
    )
    .eq('id', opts.merchantId)
    .maybeSingle();

  if (!merchant) return { approved: false, blockers: ['merchant_not_found'] };
  if (merchant.status === 'approved') {
    return { approved: true, subaccount: merchant.paystack_subaccount };
  }

  const { count } = await admin
    .from('merchant_documents')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_id', opts.merchantId);

  const assessment = assessMerchantForAutoApprove(
    merchant as MerchantAutoApproveRow,
    count ?? 0,
  );
  if (!assessment.eligible) {
    return { approved: false, blockers: assessment.blockers };
  }

  const provision = await provisionMerchantPayouts(admin, paystackPost, {
    merchantId: opts.merchantId,
    platformFeePercent: opts.platformFeePercent,
    decisionReason: `Auto-approved: ${assessment.reasons.join(', ')}`,
    sendWelcomeEmail: opts.sendWelcomeEmail,
  });

  if (!provision.ok) {
    return { approved: false, blockers: [provision.message || 'provision_failed'] };
  }

  return { approved: true, subaccount: provision.subaccount };
}
