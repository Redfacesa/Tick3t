import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import PageSeo from '@/components/PageSeo';
import { useAuth } from '@/contexts/AuthContext';
import { registerTick3tOrganizer } from '@/lib/tick3t/api';

const inputClass =
  'w-full rounded-xl border border-black/10 bg-white px-3 py-3 text-sm text-ink outline-none placeholder:text-ink/35 focus:border-brand/50';

export default function Tick3tOrganizerRegisterPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    company_name: '',
    contact_name: '',
    email: user?.email || '',
    phone: '',
    country: 'South Africa',
    bank_name: '',
    account_holder: '',
    account_number: '',
    bank_code: '',
    id_number: '',
    business_reg: '',
  });

  const set = (key: keyof typeof form, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      toast.error('Sign in to register as an organizer');
      return;
    }
    setBusy(true);
    const result = await registerTick3tOrganizer({
      ...form,
      email: form.email.trim() || user.email,
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(
        result.error === 'already_registered' ? 'You are already registered' : result.error || 'Registration failed',
      );
      if (result.error === 'already_registered') navigate('/organizer');
      return;
    }
    toast.success('Application submitted. We will review it shortly.');
    navigate('/organizer');
  };

  if (authLoading) {
    return <p className="text-sm text-ink/45">Loading…</p>;
  }

  if (!user) {
    const returnUrl = typeof window !== 'undefined' ? window.location.href : '/organizer/register';
    return (
      <>
        <PageSeo
          title="Organizer registration"
          description="Register to sell tickets on Tick3t."
          path="/organizer/register"
        />
        <div className="rounded-2xl border border-black/10 bg-mist p-8 text-center">
          <h1 className="text-xl font-extrabold">Become an organizer</h1>
          <p className="mt-2 text-sm text-ink/55">
            Sign in to apply. Settlements go to your RedFace Pay merchant account after approval.
          </p>
          <Link
            to={`/login/sell?return_url=${encodeURIComponent(returnUrl)}`}
            className="mt-5 inline-flex min-h-[44px] items-center rounded-xl bg-brand px-5 py-2 text-sm font-bold text-white"
          >
            Sign in to continue
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageSeo
        title="Organizer registration"
        description="Register to sell tickets on Tick3t."
        path="/organizer/register"
      />
      <div className="mx-auto max-w-xl space-y-6">
        <header>
          <h1 className="text-2xl font-extrabold">Organizer registration</h1>
          <p className="mt-1 text-sm text-ink/55">
            Tell us about your company and payout bank. Approval unlocks event creation and ticket sales.
          </p>
        </header>

        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-black/10 bg-mist p-5">
          <Field label="Company name" required>
            <input
              className={inputClass}
              value={form.company_name}
              onChange={(e) => set('company_name', e.target.value)}
              required
            />
          </Field>
          <Field label="Contact name" required>
            <input
              className={inputClass}
              value={form.contact_name}
              onChange={(e) => set('contact_name', e.target.value)}
              required
            />
          </Field>
          <Field label="Email" required>
            <input
              type="email"
              className={inputClass}
              value={form.email || user.email || ''}
              onChange={(e) => set('email', e.target.value)}
              required
            />
          </Field>
          <Field label="Phone">
            <input className={inputClass} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="Country">
            <input className={inputClass} value={form.country} onChange={(e) => set('country', e.target.value)} />
          </Field>
          <Field label="ID / passport number">
            <input className={inputClass} value={form.id_number} onChange={(e) => set('id_number', e.target.value)} />
          </Field>
          <Field label="Business registration">
            <input
              className={inputClass}
              value={form.business_reg}
              onChange={(e) => set('business_reg', e.target.value)}
            />
          </Field>

          <p className="pt-2 text-xs font-bold uppercase tracking-widest text-ink/40">Payout bank</p>
          <Field label="Bank name">
            <input className={inputClass} value={form.bank_name} onChange={(e) => set('bank_name', e.target.value)} />
          </Field>
          <Field label="Account holder">
            <input
              className={inputClass}
              value={form.account_holder}
              onChange={(e) => set('account_holder', e.target.value)}
            />
          </Field>
          <Field label="Account number">
            <input
              className={inputClass}
              value={form.account_number}
              onChange={(e) => set('account_number', e.target.value)}
            />
          </Field>
          <Field label="Branch / bank code">
            <input className={inputClass} value={form.bank_code} onChange={(e) => set('bank_code', e.target.value)} />
          </Field>

          <button
            type="submit"
            disabled={busy}
            className="min-h-[44px] w-full rounded-xl bg-brand py-3 text-sm font-bold text-white disabled:opacity-50"
          >
            {busy ? 'Submitting…' : 'Submit application'}
          </button>
        </form>
      </div>
    </>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-semibold text-ink/55">
        {label}
        {required ? ' *' : ''}
      </span>
      {children}
    </label>
  );
}
