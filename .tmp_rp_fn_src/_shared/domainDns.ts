// Point a registered domain at the RedFace storefront host (Vercel).

import { namecomFetch } from './namecomClient.ts';

const WWW_CNAME = Deno.env.get('STORE_DNS_WWW_CNAME') ?? 'cname.vercel-dns.com';
const APEX_A = Deno.env.get('STORE_DNS_APEX_A') ?? '76.76.21.21';

type DnsRecord = { id?: number; host?: string; type?: string; answer?: string; priority?: number };

export type DnsSpec = { host: string; type: string; answer: string; priority?: number };

function hostMatches(record: DnsRecord, host: string) {
  const h = record.host ?? '';
  if (host === '@') return h === '@' || h === '';
  return h === host;
}

export async function listDnsRecords(domainName: string): Promise<DnsRecord[]> {
  const res = await namecomFetch(`/domains/${encodeURIComponent(domainName)}/records`, { method: 'GET' });
  if (!res.ok) return [];
  return ((res.data as any)?.records ?? []) as DnsRecord[];
}

export async function deleteDnsRecord(domainName: string, recordId: number) {
  const res = await namecomFetch(
    `/domains/${encodeURIComponent(domainName)}/records/${recordId}`,
    { method: 'DELETE' },
  );
  if (!res.ok) return { ok: false, error: res.data };
  return { ok: true };
}

export async function getDomainInfo(domainName: string) {
  const res = await namecomFetch(`/domains/${encodeURIComponent(domainName)}`, { method: 'GET' });
  if (!res.ok) return { ok: false, data: res.data };
  const d = (res.data as any)?.domain ?? res.data ?? {};
  return {
    ok: true,
    domain: {
      domainName: d.domainName ?? domainName,
      nameservers: (d.nameservers ?? d.nameServers ?? []) as string[],
      expireDate: d.expireDate ?? null,
      autorenewEnabled: d.autorenewEnabled ?? null,
      privacyEnabled: d.privacyEnabled ?? null,
      locked: d.locked ?? null,
    },
  };
}

export async function setDomainNameservers(domainName: string, nameservers: string[]) {
  const cleaned = nameservers.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (!cleaned.length) return { ok: false, message: 'At least one nameserver is required.' };
  const res = await namecomFetch(`/domains/${encodeURIComponent(domainName)}:setNameservers`, {
    method: 'POST',
    body: JSON.stringify({ nameservers: cleaned }),
  });
  if (!res.ok) {
    return { ok: false, message: (res.data as any)?.message || 'Could not update nameservers' };
  }
  return { ok: true, domain: (res.data as any)?.domain ?? res.data };
}

const DEFAULT_NAMECOM_NS = ['ns1.name.com', 'ns2.name.com', 'ns3.name.com', 'ns4.name.com'];

export async function useDefaultNameservers(domainName: string) {
  return setDomainNameservers(domainName, DEFAULT_NAMECOM_NS);
}

export { DEFAULT_NAMECOM_NS };

export async function upsertDnsRecord(domainName: string, existing: DnsRecord[], spec: DnsSpec) {
  const match = existing.find((r) => hostMatches(r, spec.host) && r.type === spec.type && (spec.type !== 'MX' || r.answer === spec.answer));
  const body: Record<string, unknown> = { host: spec.host, type: spec.type, answer: spec.answer, ttl: 300 };
  if (spec.priority != null) body.priority = spec.priority;

  if (match?.id) {
    if (match.answer === spec.answer && (spec.priority == null || match.priority === spec.priority)) {
      return { ok: true, record: match, action: 'skipped' as const };
    }
    const res = await namecomFetch(
      `/domains/${encodeURIComponent(domainName)}/records/${match.id}`,
      { method: 'PUT', body: JSON.stringify(body) },
    );
    if (!res.ok) return { ok: false, error: res.data, action: 'update' as const };
    return { ok: true, record: res.data, action: 'updated' as const };
  }

  const res = await namecomFetch(
    `/domains/${encodeURIComponent(domainName)}/records`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  if (!res.ok) return { ok: false, error: res.data, action: 'create' as const };
  return { ok: true, record: res.data, action: 'created' as const };
}

async function listRecords(domainName: string): Promise<DnsRecord[]> {
  return listDnsRecords(domainName);
}

async function upsertRecord(domainName: string, existing: DnsRecord[], spec: DnsSpec) {
  return upsertDnsRecord(domainName, existing, spec);
}

export async function setupStoreDns(domainName: string): Promise<{
  ok: boolean;
  message?: string;
  target?: string;
  records?: unknown[];
}> {
  const name = domainName.trim().toLowerCase();
  if (!name) return { ok: false, message: 'domainName required' };

  const existing = await listRecords(name);
  const specs = [
    { host: 'www', type: 'CNAME', answer: WWW_CNAME },
    { host: '@', type: 'A', answer: APEX_A },
  ];

  const results: unknown[] = [];
  for (const spec of specs) {
    const result = await upsertRecord(name, existing, spec);
    if (!result.ok) {
      return {
        ok: false,
        message: (result.error as any)?.message || `DNS ${result.action} failed for ${spec.host}`,
        records: results,
      };
    }
    if (result.record) results.push(result.record);
  }

  return {
    ok: true,
    target: WWW_CNAME,
    records: results,
    message: 'Store DNS configured — allow up to 24h for propagation.',
  };
}

export function storeDnsTargets() {
  return { wwwCname: WWW_CNAME, apexA: APEX_A };
}

/** Point a Name.com domain at an InstaWP site hostname (Website Cloud). */
export async function setupWebsiteCloudDns(
  domainName: string,
  instawpHostname: string,
): Promise<{
  ok: boolean;
  message?: string;
  target?: string;
  records?: unknown[];
  apex_manual?: boolean;
}> {
  const name = domainName.trim().toLowerCase();
  const target = instawpHostname.trim().toLowerCase().replace(/\.$/, '');
  if (!name || !target) return { ok: false, message: 'domainName and instawpHostname required' };

  // Never mutate DNS on the apex redfacepay.co.za zone from Website Cloud — breaks app/login.
  if (name === 'redfacepay.co.za' || name.endsWith('.redfacepay.co.za')) {
    return {
      ok: false,
      message:
        'redfacepay.co.za and its subdomains (app, www, developers) are platform infrastructure. Connect a domain you purchased for your business instead.',
    };
  }

  const existing = await listRecords(name);
  const wwwResult = await upsertRecord(name, existing, { host: 'www', type: 'CNAME', answer: target });
  if (!wwwResult.ok) {
    return {
      ok: false,
      message: (wwwResult.error as { message?: string })?.message || 'www CNAME failed',
      records: [],
    };
  }

  const apexResult = await upsertRecord(name, existing, { host: '@', type: 'CNAME', answer: target });
  const records: unknown[] = [];
  if (wwwResult.record) records.push(wwwResult.record);
  if (apexResult.ok && apexResult.record) records.push(apexResult.record);

  if (!apexResult.ok) {
    return {
      ok: true,
      target,
      records,
      apex_manual: true,
      message: `www → ${target} configured. Root (@) may need ANAME/ALIAS at your registrar — see InstaWP domain docs.`,
    };
  }

  return {
    ok: true,
    target,
    records,
    message: `Website Cloud DNS configured — allow up to 24h for propagation.`,
  };
}
