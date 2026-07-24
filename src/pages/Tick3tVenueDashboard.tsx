import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarClock, Inbox } from 'lucide-react';
import { toast } from 'sonner';
import PageSeo from '@/components/PageSeo';
import { ImageGalleryField, ImageUploadField } from '@/components/tick3t/ImageUploadField';
import { useAuth } from '@/contexts/AuthContext';
import { fmtMoney } from '@/lib/format';
import { fetchTick3tVenuesMine, upsertTick3tVenue } from '@/lib/tick3t/api';
import type { Tick3tVenue } from '@/lib/tick3t/types';

const inputClass =
  'w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-brand/50';

type Tab =
  | 'dashboard'
  | 'venue'
  | 'profile'
  | 'pricing'
  | 'photos'
  | 'contact'
  | 'bookings'
  | 'calendar';

const TABS: { id: Tab; label: string; soon?: boolean }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'venue', label: 'My Venue' },
  { id: 'profile', label: 'Profile' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'photos', label: 'Photos' },
  { id: 'contact', label: 'Contact Details' },
  { id: 'bookings', label: 'Bookings', soon: true },
  { id: 'calendar', label: 'Availability', soon: true },
];

function emptyForm(email = '') {
  return {
    id: '',
    name: '',
    slug: '',
    description: '',
    address: '',
    city: '',
    country: 'South Africa',
    capacity: '',
    cover_image_url: '',
    photos: [] as string[],
    base_price_zar: '',
    pricing_notes: '',
    contact_name: '',
    contact_email: email,
    contact_phone: '',
    website_url: '',
    status: 'draft' as string,
  };
}

function parsePhotos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((u): u is string => typeof u === 'string' && u.length > 0).slice(0, 12);
}

export default function Tick3tVenueDashboard() {
  const { user, loading: authLoading } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'dashboard';
  const [venues, setVenues] = useState<Tick3tVenue[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => emptyForm(user?.email || ''));

  const setTab = (next: Tab) => {
    const nextSp = new URLSearchParams(sp);
    nextSp.set('tab', next);
    setSp(nextSp, { replace: true });
  };

  const reload = useCallback(async () => {
    setLoading(true);
    const list = await fetchTick3tVenuesMine();
    setVenues(list);
    setLoading(false);
    setForm((prev) => {
      if (prev.id || !list[0]) return prev;
      const v = list[0];
      return {
        id: v.id,
        name: v.name,
        slug: v.slug,
        description: v.description || '',
        address: v.address || '',
        city: v.city || '',
        country: v.country || 'South Africa',
        capacity: v.capacity != null ? String(v.capacity) : '',
        cover_image_url: v.cover_image_url || '',
        photos: parsePhotos(v.photos),
        base_price_zar: v.base_price_zar != null ? String(v.base_price_zar) : '',
        pricing_notes: v.pricing_notes || '',
        contact_name: v.contact_name || '',
        contact_email: v.contact_email || user?.email || '',
        contact_phone: v.contact_phone || '',
        website_url: v.website_url || '',
        status: v.status,
      };
    });
  }, [user?.email]);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    void reload();
  }, [user, reload]);

  useEffect(() => {
    if (!user?.email) return;
    setForm((prev) => ({
      ...prev,
      contact_email: prev.contact_email || user.email,
    }));
  }, [user?.email]);

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!form.name.trim()) {
      toast.error('Venue name is required');
      setTab('venue');
      return;
    }
    setSaving(true);
    const slug =
      form.slug.trim() ||
      form.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const { venueId, error } = await upsertTick3tVenue({
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim(),
      slug,
      description: form.description || null,
      address: form.address || null,
      city: form.city || null,
      country: form.country || 'South Africa',
      capacity: form.capacity ? Number(form.capacity) : null,
      cover_image_url: form.cover_image_url || null,
      photos: form.photos,
      base_price_zar: form.base_price_zar ? Number(form.base_price_zar) : null,
      pricing_notes: form.pricing_notes || null,
      contact_name: form.contact_name || null,
      contact_email: form.contact_email || user?.email || null,
      contact_phone: form.contact_phone || null,
      website_url: form.website_url || null,
      status: form.status as Tick3tVenue['status'],
    });
    setSaving(false);
    if (!venueId) {
      toast.error(error || 'Could not save venue');
      return;
    }
    toast.success(form.id ? 'Venue saved' : 'Venue created');
    setForm((f) => ({ ...f, id: venueId, slug }));
    await reload();
  };

  if (authLoading || loading) {
    return <p className="text-sm text-ink/45">Loading venue desk…</p>;
  }

  if (!user) {
    return (
      <>
        <PageSeo title="Venue dashboard" description="List and manage your venue on Tick3t." path="/venue" />
        <div className="rounded-2xl border border-black/10 bg-mist p-8 text-center">
          <h1 className="font-display text-2xl font-extrabold">List your venue</h1>
          <p className="mt-2 text-sm text-ink/55">
            Sign in to create your venue profile — photos, pricing, and contact details.
          </p>
          <Link
            to={`/login/venue?return_url=${encodeURIComponent('/venue')}`}
            className="mt-6 inline-flex min-h-[48px] items-center rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white"
          >
            Sign in to list venue
          </Link>
        </div>
      </>
    );
  }

  const primary = venues[0] || null;
  const completeness = [
    Boolean(form.name.trim()),
    Boolean(form.description.trim()),
    Boolean(form.cover_image_url || form.photos.length),
    Boolean(form.base_price_zar || form.pricing_notes.trim()),
    Boolean(form.contact_email || form.contact_phone),
  ].filter(Boolean).length;

  return (
    <>
      <PageSeo title="Venue dashboard" description="Manage your Tick3t venue listing." path="/venue" noindex />
      <div className="space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand">Venue owner</p>
            <h1 className="font-display text-2xl font-extrabold text-ink sm:text-3xl">
              {form.name || 'Your venue'}
            </h1>
            <p className="mt-1 text-sm text-ink/55">{user.email}</p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
          >
            {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create venue'}
          </button>
        </header>

        <nav className="flex gap-1 overflow-x-auto border-b border-black/8 pb-px">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`shrink-0 rounded-t-lg px-3 py-2.5 text-xs font-semibold sm:text-sm ${
                tab === t.id ? 'bg-brand/10 text-brand' : 'text-ink/50 hover:text-ink'
              }`}
            >
              {t.label}
              {t.soon ? <span className="ml-1 text-[10px] font-bold uppercase text-ink/30">Soon</span> : null}
            </button>
          ))}
        </nav>

        {tab === 'dashboard' && (
          <section className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-black/10 bg-mist p-4">
                <p className="text-xs text-ink/45">Profile completeness</p>
                <p className="mt-1 text-2xl font-extrabold text-ink">{completeness}/5</p>
              </div>
              <div className="rounded-2xl border border-black/10 bg-mist p-4">
                <p className="text-xs text-ink/45">Status</p>
                <p className="mt-1 text-2xl font-extrabold capitalize text-ink">
                  {form.status.replace('_', ' ') || 'draft'}
                </p>
              </div>
              <div className="rounded-2xl border border-black/10 bg-mist p-4">
                <p className="text-xs text-ink/45">From price</p>
                <p className="mt-1 text-2xl font-extrabold text-ink">
                  {form.base_price_zar ? fmtMoney(Number(form.base_price_zar)) : '—'}
                </p>
              </div>
            </div>
            {!primary && (
              <div className="rounded-2xl border border-dashed border-black/15 bg-white p-6">
                <p className="font-semibold text-ink">Create your first venue</p>
                <p className="mt-1 text-sm text-ink/55">
                  Add name, photos, pricing, and contact details so organizers can find you later.
                </p>
                <button
                  type="button"
                  onClick={() => setTab('venue')}
                  className="mt-4 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white"
                >
                  Set up My Venue
                </button>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setTab('bookings')}
                className="rounded-2xl border border-black/10 bg-white p-5 text-left transition hover:border-brand/30"
              >
                <Inbox className="h-5 w-5 text-ink/40" />
                <p className="mt-3 font-bold text-ink">Bookings</p>
                <p className="mt-1 text-sm text-ink/45">Coming soon — request inbox for organizers.</p>
              </button>
              <button
                type="button"
                onClick={() => setTab('calendar')}
                className="rounded-2xl border border-black/10 bg-white p-5 text-left transition hover:border-brand/30"
              >
                <CalendarClock className="h-5 w-5 text-ink/40" />
                <p className="mt-3 font-bold text-ink">Availability calendar</p>
                <p className="mt-1 text-sm text-ink/45">Coming soon — block dates and open slots.</p>
              </button>
            </div>
          </section>
        )}

        {(tab === 'venue' || tab === 'profile' || tab === 'pricing' || tab === 'photos' || tab === 'contact') && (
          <form onSubmit={(e) => void save(e)} className="space-y-5 rounded-2xl border border-black/10 bg-mist p-5">
            {(tab === 'venue' || tab === 'profile') && (
              <>
                <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">
                  {tab === 'venue' ? 'My Venue' : 'Profile'}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    className={inputClass}
                    placeholder="Venue name"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    required
                  />
                  <input
                    className={inputClass}
                    placeholder="Slug (url)"
                    value={form.slug}
                    onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                  />
                  <input
                    className={`${inputClass} sm:col-span-2`}
                    placeholder="Street address"
                    value={form.address}
                    onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  />
                  <input
                    className={inputClass}
                    placeholder="City"
                    value={form.city}
                    onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                  />
                  <input
                    className={inputClass}
                    placeholder="Country"
                    value={form.country}
                    onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
                  />
                  <input
                    className={inputClass}
                    placeholder="Capacity"
                    type="number"
                    min={0}
                    value={form.capacity}
                    onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
                  />
                  <select
                    className={inputClass}
                    value={form.status}
                    onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                  >
                    {['draft', 'published', 'archived'].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  className={inputClass}
                  rows={4}
                  placeholder="Description — atmosphere, facilities, what makes this space bookable"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </>
            )}

            {tab === 'pricing' && (
              <>
                <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">Pricing</p>
                <input
                  className={inputClass}
                  placeholder="Base hire price (ZAR)"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.base_price_zar}
                  onChange={(e) => setForm((f) => ({ ...f, base_price_zar: e.target.value }))}
                />
                <textarea
                  className={inputClass}
                  rows={4}
                  placeholder="Pricing notes — packages, deposits, what’s included"
                  value={form.pricing_notes}
                  onChange={(e) => setForm((f) => ({ ...f, pricing_notes: e.target.value }))}
                />
              </>
            )}

            {tab === 'photos' && (
              <>
                <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">Photos</p>
                <ImageUploadField
                  label="Cover photo"
                  value={form.cover_image_url}
                  folder="venues"
                  onChange={(url) => setForm((f) => ({ ...f, cover_image_url: url }))}
                />
                <ImageGalleryField
                  label="Venue gallery"
                  urls={form.photos}
                  max={8}
                  folder="venues"
                  onChange={(photos) => setForm((f) => ({ ...f, photos }))}
                />
              </>
            )}

            {tab === 'contact' && (
              <>
                <p className="text-[10px] font-bold uppercase tracking-widest text-ink/40">Contact details</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    className={inputClass}
                    placeholder="Contact name"
                    value={form.contact_name}
                    onChange={(e) => setForm((f) => ({ ...f, contact_name: e.target.value }))}
                  />
                  <input
                    className={inputClass}
                    placeholder="Contact email"
                    type="email"
                    value={form.contact_email}
                    onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))}
                  />
                  <input
                    className={inputClass}
                    placeholder="Contact phone"
                    value={form.contact_phone}
                    onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
                  />
                  <input
                    className={inputClass}
                    placeholder="Website URL"
                    value={form.website_url}
                    onChange={(e) => setForm((f) => ({ ...f, website_url: e.target.value }))}
                  />
                </div>
              </>
            )}

            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </form>
        )}

        {tab === 'bookings' && (
          <div className="rounded-2xl border border-dashed border-black/15 bg-mist p-8 text-center">
            <Inbox className="mx-auto h-8 w-8 text-ink/30" />
            <h2 className="mt-4 font-display text-xl font-bold text-ink">Bookings — coming soon</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-ink/55">
              Organizers will request your space here. For now, keep your listing ready with photos and
              pricing.
            </p>
          </div>
        )}

        {tab === 'calendar' && (
          <div className="rounded-2xl border border-dashed border-black/15 bg-mist p-8 text-center">
            <CalendarClock className="mx-auto h-8 w-8 text-ink/30" />
            <h2 className="mt-4 font-display text-xl font-bold text-ink">
              Availability calendar — coming soon
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-ink/55">
              Block dates and publish open slots in the next marketplace phase.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
