/**
 * Tick3t — RedFace platform ticketing engine.
 * Doctrine: reusable across client sites; event data lives in tick3t_events, never hardcoded here.
 */

export type Tick3tTicketStatus =
  | 'pending_payment'
  | 'paid'
  | 'valid'
  | 'checked_in'
  | 'used'
  | 'refunded'
  | 'cancelled'
  | 'expired';

export type Tick3tOrganizerStatus =
  | 'pending'
  | 'changes_requested'
  | 'approved'
  | 'rejected'
  | 'frozen';

export type Tick3tEvent = {
  id: string;
  merchant_id: string;
  slug: string;
  title: string;
  venue: string | null;
  city: string | null;
  event_date: string | null;
  doors_time: string | null;
  end_time: string | null;
  lineup: string | null;
  description: string | null;
  capacity: number | null;
  status: 'draft' | 'published' | 'on_sale' | 'sold_out' | 'cancelled' | 'completed';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  category?: string | null;
  maps_url?: string | null;
  age_restriction?: string | null;
  terms?: string | null;
  refund_policy?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  website_url?: string | null;
  instagram_url?: string | null;
  facebook_url?: string | null;
  gallery?: unknown;
  hero_image_url?: string | null;
  poster_image_url?: string | null;
};

export type Tick3tPublicEvent = {
  id: string;
  merchant_id: string;
  slug: string;
  title: string;
  venue: string | null;
  city: string | null;
  event_date: string | null;
  doors_time: string | null;
  end_time: string | null;
  lineup: string | null;
  description: string | null;
  hero_image_url: string | null;
  poster_image_url: string | null;
  capacity: number | null;
  status: string;
  category: string | null;
  maps_url: string | null;
  age_restriction: string | null;
  organizer_name: string | null;
  from_price_zar: number | null;
  terms?: string | null;
  refund_policy?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  website_url?: string | null;
  instagram_url?: string | null;
  facebook_url?: string | null;
  gallery?: unknown;
};

export type Tick3tTicketType = {
  id: string;
  event_id: string;
  merchant_id: string;
  name: string;
  description: string | null;
  price_zar: number;
  capacity: number | null;
  sold_count?: number;
  status: 'draft' | 'on_sale' | 'sold_out' | 'hidden' | string;
  sort_order?: number;
  sale_opens_at?: string | null;
  sale_closes_at?: string | null;
  max_per_customer?: number | null;
  metadata?: Record<string, unknown>;
};

export type Tick3tOrganizer = {
  id: string;
  merchant_id: string | null;
  auth_user_id: string | null;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  country: string;
  bank_name: string | null;
  account_holder: string | null;
  account_number: string | null;
  bank_code: string | null;
  id_number: string | null;
  business_reg: string | null;
  logo_url: string | null;
  status: Tick3tOrganizerStatus;
  commission_rate: number;
  admin_notes: string | null;
  risk_score: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type Tick3tTicket = {
  id: string;
  ticket_code: string;
  qr_token: string | null;
  event_name: string;
  product_name: string;
  buyer_name: string | null;
  buyer_email: string;
  quantity: number;
  amount_zar: number;
  venue: string | null;
  event_date: string | null;
  status: Tick3tTicketStatus;
  checked_in_at: string | null;
  emailed_at: string | null;
  created_at: string;
  merchant_id?: string;
  event_id?: string | null;
};

export type Tick3tScanResult =
  | { ok: true; code: 'valid'; message: string; ticket: Record<string, unknown> }
  | { ok: false; code: string; message: string; ticket?: Record<string, unknown> };

export type Tick3tDashboardStats = {
  total_tickets: number;
  valid: number;
  checked_in: number;
  revenue_zar: number;
  recent_scans: Array<{ id: string; result: string; created_at: string }>;
};

export type Tick3tAdminDashboard = {
  ok: boolean;
  pending_organizers: number;
  approved_organizers: number;
  events_live: number;
  tickets_sold: number;
  revenue_zar: number;
  checked_in_today: number;
  message?: string;
};

export type Tick3tOrganizerRegisterPayload = {
  company_name: string;
  contact_name: string;
  email: string;
  phone?: string;
  country?: string;
  bank_name?: string;
  account_holder?: string;
  account_number?: string;
  bank_code?: string;
  id_number?: string;
  business_reg?: string;
  logo_url?: string;
};
