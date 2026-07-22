# Tick3t

**The easiest way in Africa to create, manage and sell tickets for any event.**

Tick3t is a **Ticketing Operating System**. RedFace Pay is the invisible payment engine underneath.

## Product split

| Product | Role |
|---------|------|
| **Tick3t** | Events, ticket types, checkout UX, QR tickets, door scan, organizer & admin ops |
| **RedFace Pay** | Merchant identity, KYC, Paystack subaccounts, payment sessions, settlements |
| **Entendre** | First live client / vertical experience on the same ticket engine |

Nobody needs to see Paystack. Settlements flow: Tick3t → RedFace Pay → payment partner → organizer bank.

## Architecture

```
Tick3t App (/tick3t)
        │
────────▼────────
 Ticket Engine
 (tick3t_events, ticket types, merchant_event_tickets, scan log)
────────▲────────
        │
 RedFace Pay API + Supabase
        │
        ▼
 Settlement (organizer subaccount or platform ACCT_wdduxlx635w9vo2)
```

## Where the code lives (v1)

Implementation ships inside the RedFace Pay monorepo so one database, one identity, and one Document Engine stay shared:

- App routes: `https://www.redfacepay.co.za/tick3t`
- Source: [Redfacesa/Redface-pay](https://github.com/Redfacesa/Redface-pay) → `src/pages/tick3t/`, `src/components/tick3t/`, `src/lib/tick3t/`
- Migrations: `supabase/migrations/0316_tick3t_engine_foundation.sql`, `0323_tick3t_os_foundation.sql`

This repository holds brand assets and product docs. A standalone Tick3t deploy can fork from Pay later without changing the engine contract.

## Brand

See `/brand`:

- `icon.png` — mark only
- `wordmark.png` — Tick3t wordmark
- `lockup.png` — full lockup with tagline

## Admins

- `info@redfacepay.co.za` — platform + Tick3t admin
- `3ntendr3@gmail.com` — Tick3t / Entendre ecosystem admin

## Quick links

- Browse events: [/tick3t](https://www.redfacepay.co.za/tick3t)
- Organizer register: [/tick3t/organizer/register](https://www.redfacepay.co.za/tick3t/organizer/register)
- Product page: [/product/tick3t](https://www.redfacepay.co.za/product/tick3t)
- Apps catalog: [/apps](https://www.redfacepay.co.za/apps)

## Out of scope for v1

Seat maps, Apple/Google Wallet, SMS/push campaigns, affiliates, offline scanner sync. Schema hooks exist where cheap; product ships later.
