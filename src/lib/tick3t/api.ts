import { COMPANY_INFO, REDFACE_PAY_ORIGIN } from '@/lib/company';
import { supabase } from '@/lib/supabase';
import type {
  Tick3tAdminDashboard,
  Tick3tDashboardStats,
  Tick3tEvent,
  Tick3tOrganizer,
  Tick3tOrganizerRegisterPayload,
  Tick3tOrganizerStatus,
  Tick3tPublicEvent,
  Tick3tScanResult,
  Tick3tTicket,
  Tick3tTicketType,
} from '@/lib/tick3t/types';

export async function fetchTick3tEvents(merchantId: string): Promise<Tick3tEvent[]> {
  const { data, error } = await supabase.rpc('tick3t_events_list', { p_merchant_id: merchantId });
  if (error || !data?.ok) return [];
  return (data.events ?? []) as Tick3tEvent[];
}

export async function upsertTick3tEvent(
  merchantId: string,
  payload: Partial<Tick3tEvent> & { slug: string; title: string },
): Promise<{ eventId: string | null; error?: string }> {
  const { data, error } = await supabase.rpc('tick3t_event_upsert', {
    p_merchant_id: merchantId,
    p_payload: payload,
  });
  if (error) return { eventId: null, error: error.message };
  if (!data?.ok) return { eventId: null, error: data?.message || 'Could not save event' };
  return { eventId: data.event_id as string };
}

export async function upsertTick3tTicketType(
  merchantId: string,
  eventId: string,
  payload: Partial<Tick3tTicketType> & { name: string; price_zar: number },
): Promise<{ ticketTypeId: string | null; error?: string }> {
  const { data, error } = await supabase.rpc('tick3t_ticket_type_upsert', {
    p_merchant_id: merchantId,
    p_event_id: eventId,
    p_payload: payload,
  });
  if (error) return { ticketTypeId: null, error: error.message };
  if (!data?.ok) return { ticketTypeId: null, error: data?.message || 'Could not save ticket type' };
  return { ticketTypeId: data.ticket_type_id as string };
}

export async function fetchPublicTick3tEvents(opts?: {
  query?: string;
  category?: string;
  limit?: number;
}): Promise<Tick3tPublicEvent[]> {
  const { data, error } = await supabase.rpc('tick3t_public_events_list', {
    p_query: opts?.query?.trim() || null,
    p_category: opts?.category?.trim() || null,
    p_limit: opts?.limit ?? 50,
  });
  if (error || !data?.ok) return [];
  return (data.events ?? []) as Tick3tPublicEvent[];
}

export async function fetchPublicTick3tEvent(
  slug: string,
  merchantId?: string,
): Promise<{ event: Tick3tPublicEvent; ticketTypes: Tick3tTicketType[] } | null> {
  const { data, error } = await supabase.rpc('tick3t_public_event_get', {
    p_slug: slug,
    p_merchant_id: merchantId || null,
  });
  if (error || !data?.ok) return null;
  return {
    event: data.event as Tick3tPublicEvent,
    ticketTypes: (data.ticket_types ?? []) as Tick3tTicketType[],
  };
}

export async function registerTick3tOrganizer(
  payload: Tick3tOrganizerRegisterPayload,
): Promise<{ ok: boolean; organizerId?: string; merchantId?: string; status?: string; error?: string }> {
  const { data, error } = await supabase.rpc('tick3t_organizer_register', { p_payload: payload });
  if (error) return { ok: false, error: error.message };
  if (!data?.ok) return { ok: false, error: data?.message || 'Registration failed' };
  return {
    ok: true,
    organizerId: data.organizer_id as string,
    merchantId: data.merchant_id as string,
    status: data.status as string,
  };
}

export async function fetchTick3tOrganizerMe(): Promise<Tick3tOrganizer | null> {
  const { data, error } = await supabase.rpc('tick3t_organizer_me');
  if (error || !data?.ok) return null;
  return (data.organizer ?? null) as Tick3tOrganizer | null;
}

export async function fetchTick3tAdminOrganizers(
  status?: Tick3tOrganizerStatus | null,
): Promise<{ organizers: Tick3tOrganizer[]; error?: string }> {
  const { data, error } = await supabase.rpc('tick3t_admin_organizers_list', {
    p_status: status || null,
  });
  if (error) return { organizers: [], error: error.message };
  if (!data?.ok) return { organizers: [], error: data?.message || 'not_authorized' };
  return { organizers: (data.organizers ?? []) as Tick3tOrganizer[] };
}

export async function setTick3tOrganizerStatus(
  organizerId: string,
  status: Tick3tOrganizerStatus,
  opts?: { notes?: string; commissionRate?: number },
): Promise<{
  ok: boolean;
  error?: string;
  merchantId?: string;
  needsSubaccount?: boolean;
}> {
  const { data, error } = await supabase.rpc('tick3t_admin_organizer_set_status', {
    p_organizer_id: organizerId,
    p_status: status,
    p_notes: opts?.notes ?? null,
    p_commission_rate: opts?.commissionRate ?? null,
  });
  if (error) return { ok: false, error: error.message };
  if (!data?.ok) return { ok: false, error: data?.message || 'Update failed' };
  return {
    ok: true,
    merchantId: data.merchant_id as string | undefined,
    needsSubaccount: Boolean(data.needs_subaccount),
  };
}

export async function fetchTick3tAdminDashboard(): Promise<Tick3tAdminDashboard | null> {
  const { data, error } = await supabase.rpc('tick3t_admin_dashboard');
  if (error || !data?.ok) return null;
  return data as Tick3tAdminDashboard;
}

export async function fetchMyTick3tTickets(): Promise<{ tickets: Tick3tTicket[]; error?: string }> {
  const { data, error } = await supabase.rpc('tick3t_my_tickets');
  if (error) return { tickets: [], error: error.message };
  if (!data?.ok) return { tickets: [], error: data?.message || 'login_required' };
  return { tickets: (data.tickets ?? []) as Tick3tTicket[] };
}

export async function fetchTick3tSettlementSubaccount(merchantId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('tick3t_settlement_subaccount', {
    p_merchant_id: merchantId,
  });
  if (error) return null;
  return (data as string) || null;
}

export async function checkTick3tIsAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('tick3t_is_admin');
  if (error) return false;
  return data === true;
}

export async function fetchTick3tTickets(merchantId: string): Promise<Tick3tTicket[]> {
  const { data, error } = await supabase.rpc('merchant_event_tickets_list', {
    p_merchant_id: merchantId,
    p_limit: 300,
  });
  if (error || !data?.ok) return [];
  return (data.tickets ?? []) as Tick3tTicket[];
}

export async function validateAndCheckIn(
  merchantId: string,
  qrPayload: string,
): Promise<Tick3tScanResult> {
  const { data, error } = await supabase.rpc('tick3t_validate_and_checkin', {
    p_merchant_id: merchantId,
    p_qr_payload: qrPayload,
    p_device_info: { ua: navigator.userAgent, at: new Date().toISOString() },
  });

  if (error) {
    return { ok: false, code: 'error', message: error.message };
  }

  return data as Tick3tScanResult;
}

export async function fetchTick3tStats(merchantId: string): Promise<Tick3tDashboardStats | null> {
  const { data, error } = await supabase.rpc('tick3t_dashboard_stats', {
    p_merchant_id: merchantId,
  });
  if (error || !data?.ok) return null;
  return data as Tick3tDashboardStats;
}

export function ticketStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending_payment: 'Pending payment',
    paid: 'Paid',
    valid: 'Valid',
    checked_in: 'Checked in',
    used: 'Used',
    refunded: 'Refunded',
    cancelled: 'Cancelled',
    expired: 'Expired',
  };
  return labels[status] ?? status;
}

export function organizerStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Pending review',
    changes_requested: 'Changes requested',
    approved: 'Approved',
    rejected: 'Rejected',
    frozen: 'Frozen',
  };
  return labels[status] ?? status;
}

/** Checkout URL for Tick3t ticket purchase via RedFace Pay (/pay ecosystem checkout). */
export function buildTick3tCheckoutUrl(
  merchantId: string,
  event: Pick<Tick3tPublicEvent | Tick3tEvent, 'id' | 'slug' | 'title' | 'venue' | 'event_date'>,
  ticketType: Pick<Tick3tTicketType, 'id' | 'name' | 'price_zar'>,
  qty: number,
  buyer?: { email?: string; name?: string },
): string {
  const quantity = Math.max(1, Math.floor(qty || 1));
  const unit = Number(ticketType.price_zar) || 0;
  const amount = unit * quantity;
  const site = COMPANY_INFO.website.replace(/\/$/, '');
  const bookingId = `tick3t:${event.id}:${ticketType.id}`;
  const label = `${event.title} · ${ticketType.name}${quantity > 1 ? ` x${quantity}` : ''}`;

  const cartItems = [
    {
      type: 'ticket',
      product_type: 'ticket',
      name: ticketType.name,
      quantity,
      price: unit,
      ticket_type_id: ticketType.id,
      event_id: event.id,
    },
  ];

  const q = new URLSearchParams({
    utm_source: 'tick3t',
    utm_medium: 'ticket_checkout',
    ecosystem_from: 'tick3t',
    merchant_id: merchantId,
    booking_id: bookingId,
    amount: String(amount),
    label,
    return_url: `${site}/tickets`,
    cart_items: JSON.stringify(cartItems),
    event_id: event.id,
    ticket_type_id: ticketType.id,
    event_name: event.title,
    feature: 'tick3t',
  });
  if (event.venue) q.set('venue', event.venue);
  if (event.event_date) q.set('event_date', event.event_date);
  if (buyer?.email) q.set('login_hint', buyer.email.trim().toLowerCase());
  if (buyer?.name) q.set('buyer_name', buyer.name.trim());
  return `${REDFACE_PAY_ORIGIN}/pay?${q.toString()}`;
}
