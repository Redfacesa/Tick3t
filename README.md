# Tick3t

**The easiest way in Africa to create, manage and sell tickets for any event.**

Tick3t is a **Ticketing Operating System**. RedFace Pay is the invisible payment engine underneath.

## Stack

- Vite 5 + React 18 + React Router 6 + Tailwind
- Shared Supabase hub (same project as RedFace Pay)
- Clerk auth (same app as Pay when configured)
- Checkout deep-links to RedFace Pay `/pay`

## Product split

| Product | Role |
|---------|------|
| **Tick3t** (this repo) | Events, ticket types, checkout UX, QR tickets, door scan, organizer & admin |
| **RedFace Pay** | Merchant identity, KYC, Paystack subaccounts, payment sessions, settlements |

## Local development

```bash
cp .env.example .env
# Fill VITE_SUPABASE_* and VITE_CLERK_PUBLISHABLE_KEY (same values as RedFace Pay)
npm install
npm run dev
```

## Deploy (Vercel)

1. Import this GitHub repo in Vercel.
2. Framework preset: **Vite**. Output directory: `dist`.
3. Set env vars from `.env.example`.
4. Add `tick3t.online` / `www.tick3t.online` (and `*.vercel.app`) as Clerk allowed origins.
5. `vercel.json` already rewrites all routes to `index.html` (SPA).

## Routes

| Path | Page |
|------|------|
| `/` | Browse events |
| `/events/:slug` | Event + buy |
| `/tickets` | My ticket wallet |
| `/organizer` | Organizer dashboard |
| `/organizer/register` | Organizer application |
| `/staff` | Door check-in scanner |
| `/admin` | Platform admin |
| `/login` | Clerk sign-in |

Legacy `/tick3t/*` URLs redirect to the paths above.

## Brand

Source assets in `/brand` (also served from `/public/tick3t` at runtime):

- `icon.png` — mark only
- `wordmark.png` — Tick3t wordmark
- `lockup.png` — full lockup with tagline

## Platform co-owners (Tick3t admins)

Tick3t is co-owned by **RedFace Pay** and **Entendre**. These emails are platform admins (hub `platform_ecosystem_apps.admin_emails` for `tick3t` + `entendre`, mirrored in `src/lib/tick3t/admins.ts`):

- `info@redfacepay.co.za` — RedFace Pay
- `3ntendr3@gmail.com` — Entendre

## Related

- Payment engine / monorepo: [Redfacesa/Redface-pay](https://github.com/Redfacesa/Redface-pay)
- Live Pay checkout: `https://www.redfacepay.co.za/pay`
