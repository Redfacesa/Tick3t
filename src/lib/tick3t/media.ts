import { supabase } from '@/lib/supabase';

const BUCKET = 'tick3t-media';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function extFor(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

export async function uploadTick3tMedia(
  file: File,
  folder: 'events' | 'venues',
): Promise<{ url: string | null; error?: string }> {
  if (!ALLOWED.has(file.type)) {
    return { url: null, error: 'Use JPEG, PNG, WebP, or GIF' };
  }
  if (file.size > MAX_BYTES) {
    return { url: null, error: 'Image must be under 5 MB' };
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const owner = session?.user?.id || 'uploads';
  const path = `${owner}/${folder}/${crypto.randomUUID()}.${extFor(file.type)}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type,
  });
  if (error) return { url: null, error: error.message };

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { url: data.publicUrl };
}
