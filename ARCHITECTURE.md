# Tick3t — Architecture

## High-level split

```mermaid
flowchart LR
  attendee[Attendee]
  organizer[Organizer]
  staff[DoorStaff]
  tick3t[Tick3tApp]
  hub[SharedSupabase]
  pay[RedFacePay]
  paystack[Paystack]

  attendee --> tick3t
  organizer --> tick3t
  staff --> tick3t
  tick3t --> hub
  tick3t -->|"checkout /pay"| pay
  pay --> hub
  pay --> paystack
  paystack -->|"webhook paid"| hub
  hub -->|"issue tickets"| hub
```

## Repositories

| Repo | Role |
|------|------|
| **Tick3t** (this) | Vite SPA: discovery, event UX, organizer OS, staff scanner, admin shell |
| **Redface-pay** | Payment OS + shared Supabase migrations + edge functions |

## Identity

- **Primary:** Clerk signup/sign-in stays on Tick3t (`VITE_CLERK_PUBLISHABLE_KEY`).
- `clerk-link` finds/creates the shared hub `auth.users` row and `auth_identity_links`.
- Organizer/venue register creates a RedFace `merchants` row (`signup_vertical = tick3t`) in the same DB — no second Pay signup.
- **Fallback:** RedFace Pay ecosystem SSO when Clerk is not configured (or via “Prefer RedFace Pay sign-in”).
- Organizers map to `tick3t_organizers` ↔ `merchants`.
- Platform admins: `platform_ecosystem_apps.admin_emails` + `src/lib/tick3t/admins.ts`.

## Data (hub)

Core tables:

- `tick3t_events` — event workspace  
- `tick3t_ticket_types` — SKUs (price, capacity, sale windows)  
- `tick3t_organizers` — seller applications  
- `tick3t_venues` — venue inventory (Phase 1 listing; bookings later)  
- `tick3t_scan_log` — check-in audit  
- `tick3t_staff` — door/ops roles (Phase 1)  
- `tick3t_promo_codes` — discounts (Phase 1)  
- `tick3t_refund_requests` — refund workflow (Phase 1)  
- `merchant_event_tickets` — issued tickets (QR, status) — shared with Entendre  
- Shared hub migration for commerce onboard: `0336_tick3t_merchant_commerce_onboard.sql` (RedFace Pay repo)  

## Commerce path

1. Organizer / venue owner signs up on Tick3t → hub creates a **RedFace `merchants`** row (`signup_vertical = tick3t`).
2. With bank details on file, Tick3t calls Pay `tick3t_provision_subaccount` → Paystack `ACCT_…` saved on that merchant (never the platform ACCT_ for third parties).
3. Tick3t builds checkout URL: `REDFACE_PAY_ORIGIN/pay?ecosystem_from=tick3t&…`
4. Pay `init_payment` treats Tick3t lines as **ticket metadata**, not catalog products, and **refuses** checkout if the seller cannot receive payouts.
5. Paystack confirms → webhook / trigger → `issue_event_tickets_for_transaction`.
6. Buyer sees tickets on `/tickets`; door validates via `tick3t_validate_and_checkin`.

**Rule:** Tick3t is the experience; RedFace Pay is the commerce engine. Every seller is a Pay merchant with their own settlement route.

## Service boundaries

**Tick3t may:**

- CRUD events, ticket types, staff, promos, refund *requests*  
- Render dashboards from RPC aggregates  
- Deep-link to Pay for checkout, payouts UI, merchant onboarding  

**Tick3t must not:**

- Call Paystack directly  
- Store card data  
- Invent a second wallet or settlement ledger  

**RedFace Pay owns:**

- `init_payment`, webhooks, subaccounts, fees, payouts, invoices, store credit  

## Frontend modules

```
src/pages/          # Route-level screens
src/components/tick3t/
src/lib/tick3t/     # API wrappers, types, QR helpers, admins
src/contexts/       # Auth
```

## Multi-country

Design for multi-currency and localization early; Phase 1 ships ZAR / South Africa defaults via Pay.

## Scaling notes

- Check-in RPCs are merchant-scoped and idempotent on QR.  
- Offline scanner queues payloads in `localStorage` and flushes when online.  
- Public catalog RPCs are security definer and read-only for anon.
