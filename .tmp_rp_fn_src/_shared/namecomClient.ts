// Minimal name.com API client (DNS + domain ops).

const NAMECOM_USER = Deno.env.get('NAMECOM_USERNAME') ?? '';
const NAMECOM_TOKEN = Deno.env.get('NAMECOM_API_TOKEN') ?? '';
const NAMECOM_BASE = (Deno.env.get('NAMECOM_API_BASE') ?? 'https://api.name.com').replace(/\/$/, '');

function namecomAuthHeader() {
  return `Basic ${btoa(`${NAMECOM_USER}:${NAMECOM_TOKEN}`)}`;
}

export async function namecomFetch(path: string, init: RequestInit = {}) {
  if (!NAMECOM_USER || !NAMECOM_TOKEN) {
    return { ok: false, status: 503, data: { error: 'Domain API not configured' } };
  }
  const res = await fetch(`${NAMECOM_BASE}/core/v1${path}`, {
    ...init,
    headers: {
      Authorization: namecomAuthHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = { error: await res.text() };
  }
  return { ok: res.ok, status: res.status, data };
}
