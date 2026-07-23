/** Offline door-scan queue — sync when connectivity returns. */

const KEY = 'tick3t_offline_scan_queue_v1';

export type OfflineScanItem = {
  id: string;
  merchantId: string;
  payload: string;
  queuedAt: string;
};

function readQueue(): OfflineScanItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OfflineScanItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(items: OfflineScanItem[]) {
  localStorage.setItem(KEY, JSON.stringify(items.slice(0, 500)));
}

export function enqueueOfflineScan(merchantId: string, payload: string): OfflineScanItem {
  const item: OfflineScanItem = {
    id: crypto.randomUUID(),
    merchantId,
    payload,
    queuedAt: new Date().toISOString(),
  };
  const next = [...readQueue(), item];
  writeQueue(next);
  return item;
}

export function listOfflineScans(merchantId?: string): OfflineScanItem[] {
  const all = readQueue();
  return merchantId ? all.filter((i) => i.merchantId === merchantId) : all;
}

export function removeOfflineScan(id: string) {
  writeQueue(readQueue().filter((i) => i.id !== id));
}

export async function flushOfflineScans(
  validate: (merchantId: string, payload: string) => Promise<{ ok: boolean }>,
): Promise<{ flushed: number; failed: number }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { flushed: 0, failed: 0 };
  }
  const queue = readQueue();
  let flushed = 0;
  let failed = 0;
  const remaining: OfflineScanItem[] = [];
  for (const item of queue) {
    try {
      const result = await validate(item.merchantId, item.payload);
      if (result.ok) flushed += 1;
      else {
        // Duplicates / already used still count as processed — drop from queue
        flushed += 1;
      }
    } catch {
      failed += 1;
      remaining.push(item);
    }
  }
  writeQueue(remaining);
  return { flushed, failed };
}
