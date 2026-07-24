import { useRef, useState } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { uploadTick3tMedia } from '@/lib/tick3t/media';
import { cls } from '@/lib/format';

type Props = {
  label: string;
  value: string | null | undefined;
  onChange: (url: string) => void;
  required?: boolean;
  folder?: 'events' | 'venues';
  className?: string;
};

export function ImageUploadField({
  label,
  value,
  onChange,
  required,
  folder = 'events',
  className,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const { url, error } = await uploadTick3tMedia(file, folder);
    setBusy(false);
    if (!url) {
      toast.error(error || 'Upload failed');
      return;
    }
    onChange(url);
    toast.success('Image uploaded');
  };

  return (
    <div className={cls('space-y-2', className)}>
      <p className="text-xs font-semibold text-ink/55">
        {label}
        {required ? <span className="text-brand"> *</span> : null}
      </p>
      {value ? (
        <div className="relative overflow-hidden rounded-xl border border-black/10 bg-white">
          <img src={value} alt="" className="h-40 w-full object-cover" />
          <div className="absolute inset-x-0 bottom-0 flex gap-2 bg-gradient-to-t from-black/60 to-transparent p-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="rounded-lg bg-white/95 px-3 py-1.5 text-xs font-bold text-ink"
            >
              Replace
            </button>
            {!required && (
              <button
                type="button"
                onClick={() => onChange('')}
                className="rounded-lg bg-white/95 px-3 py-1.5 text-xs font-bold text-ink"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-black/20 bg-white text-ink/45 transition hover:border-brand/40 hover:text-ink/70"
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
          <span className="text-xs font-semibold">{busy ? 'Uploading…' : 'Upload image'}</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          void onPick(file);
        }}
      />
    </div>
  );
}

type GalleryProps = {
  label?: string;
  urls: string[];
  max?: number;
  onChange: (urls: string[]) => void;
  folder?: 'events' | 'venues';
};

export function ImageGalleryField({
  label = 'Gallery',
  urls,
  max = 5,
  onChange,
  folder = 'events',
}: GalleryProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const remaining = Math.max(0, max - urls.length);

  const onPick = async (files: FileList | null) => {
    if (!files?.length || remaining <= 0) return;
    setBusy(true);
    const next = [...urls];
    for (const file of Array.from(files).slice(0, remaining)) {
      const { url, error } = await uploadTick3tMedia(file, folder);
      if (!url) {
        toast.error(error || 'Upload failed');
        continue;
      }
      next.push(url);
    }
    setBusy(false);
    onChange(next);
    if (next.length > urls.length) toast.success('Gallery updated');
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink/55">
          {label}{' '}
          <span className="font-normal text-ink/35">
            (optional, up to {max})
          </span>
        </p>
        {remaining > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="text-xs font-bold text-brand hover:underline disabled:opacity-40"
          >
            {busy ? 'Uploading…' : 'Add images'}
          </button>
        )}
      </div>
      {urls.length === 0 ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="flex h-28 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-black/20 bg-white text-ink/45"
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
          <span className="text-xs font-semibold">VIP flyer, line-up, venue map…</span>
        </button>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
          {urls.map((url) => (
            <li key={url} className="relative overflow-hidden rounded-lg border border-black/10">
              <img src={url} alt="" className="aspect-square w-full object-cover" />
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => onChange(urls.filter((u) => u !== url))}
                className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          e.target.value = '';
          void onPick(files);
        }}
      />
    </div>
  );
}
