# Tick3t — Roadmap

Phased plan for Africa's Event Operating System. Current focus: **Phase 1**.

---

## Phase 1 — Core Operating System (production ready)

Make Tick3t the best event management platform before marketplaces.

| Capability | Status target |
|------------|---------------|
| Event workspace | Full CRUD: media, lineup, policies, contacts, capacity |
| Event publishing workflow | `draft` → `published` / `on_sale` → `sold_out` / `completed` / `cancelled` |
| Ticket management | Multiple types, description, status, sort order |
| Capacities | Event + per-type capacity; sold_count awareness |
| Sale windows | `sale_opens_at` / `sale_closes_at` enforced at buy time |
| Promo codes | Organizer codes with % or fixed discount |
| QR ticket generation | Via Pay paid → `issue_event_tickets_for_transaction` |
| Offline QR scanner | Queue scans locally; sync when online |
| Fast door check-in | `/staff` + `/checkin`; camera + manual |
| Staff roles & permissions | Invite staff; roles: owner, manager, scanner, … |
| Organizer dashboard | Overview, events, tickets, staff, finance, promos, profile |
| Financial dashboard | Revenue / fees visibility via Pay + Tick3t stats |
| Live sales analytics | Sold, checked-in, revenue, recent scans |
| Refund management | Organizer mark refunded / request path |
| Organizer profile | Company, bank, contact details |
| Customer ticket history | `/tickets` wallet |

**Out of Phase 1:** venue marketplace, service marketplace, ambassadors, seating maps, AI.

---

## Phase 2 — Event discovery

Homepage, trending, near you, weekend, search, categories, featured organizers, recommendations, reviews, saved events.

## Phase 3 — Organizer growth tools

Ambassadors, referral links, influencer tracking, campaigns, WhatsApp/email, marketing analytics. (Promo codes start in Phase 1; campaigns expand here.)

## Phase 4 — Venue marketplace

Venue profiles, availability, booking requests, quotes, deposits via RedFace Pay, reviews.

## Phase 5 — Event services marketplace

DJs, MCs, photographers, security, decor, catering, sound, lighting, furniture hire.

## Phase 6 — Sponsor & vendor hub

Applications, booths, contracts, payments, sponsor analytics.

## Phase 7 — AI & intelligence

Forecasting, attendance prediction, marketing recommendations, dynamic pricing insights, performance reports.

---

## Definition of done (Phase 1)

An approved organizer can create a full event, configure ticket types with capacity and sale windows, publish, sell via RedFace Pay, issue QR tickets, assign door staff, check in (including offline queue), view sales/finance stats, manage refunds, and run promos — without leaving Tick3t for operations (Pay only for money movement).
