# Tick3t

**Africa's Event Operating System** — create, manage, sell, and run events. RedFace Pay is the payment engine underneath.

## Guiding docs

| Doc | Purpose |
|-----|---------|
| [VISION.md](./VISION.md) | Product vision & north star |
| [AGENTS.md](./AGENTS.md) | AI / developer principles |
| [ROADMAP.md](./ROADMAP.md) | Phased plan (current: **Phase 1**) |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Tick3t vs RedFace Pay boundaries |

## Stack

- Vite 5 + React 18 + React Router 6 + Tailwind
- Shared Supabase hub (same project as RedFace Pay)
- Clerk auth (same app as Pay when configured)
- Checkout deep-links to RedFace Pay `/pay`

## Product split

| Product | Role |
|---------|------|
| **Tick3t** (this repo) | Events, discovery, ticketing, QR, door scan, organizer OS, admin |
| **RedFace Pay** | Merchant identity, KYC, Paystack, settlements, wallets, payouts |

## Local development

```bash
cp .env.example .env
# Fill VITE_SUPABASE_* and VITE_CLERK_PUBLISHABLE_KEY (same values as RedFace Pay)
npm install
npm run dev
```

Hub migrations for Tick3t live in the RedFace Pay repo (`supabase/migrations/0333_tick3t_phase1_ops.sql` and earlier). Apply them to the shared Supabase project before using staff / promos / refunds RPCs.

## Deploy (Vercel)

1. Import this GitHub repo in Vercel.
2. Framework preset: **Vite**. Output directory: `dist`.
3. Set env vars from `.env.example`.
4. Add `tick3t.online` / `www.tick3t.online` (and `*.vercel.app`) as Clerk allowed origins.
5. `vercel.json` already rewrites all routes to `index.html` (SPA).

## Routes

| Path | Page |
|------|------|
| `/` | Landing + live events |
| `/events/:slug` | Event + buy |
| `/tickets` | My ticket wallet |
| `/organizer` | Organizer OS (workspace, tickets, staff, promos, finance) |
| `/organizer/register` | Organizer application |
| `/staff` · `/checkin` | Door check-in (offline queue supported) |
| `/admin` | Platform admin |
| `/login` | Role chooser |
| `/login/admin` · `/sell` · `/buy` | Role sign-in |

Legacy `/tick3t/*` URLs redirect to the paths above.

## Brand

Source assets in `/brand` (also served from `/public/tick3t` at runtime):

- `icon.png` — mark only
- `wordmark.png` — Tick3t wordmark
- `lockup.png` — full lockup with tagline

## Platform co-owners (Tick3t admins)

- `info@redfacepay.co.za` — RedFace Pay
- `3ntendr3@gmail.com` — Entendre

## Related

- Payment engine: [Redfacesa/Redface-pay](https://github.com/Redfacesa/Redface-pay)
- Live Pay checkout: `https://www.redfacepay.co.za/pay`
