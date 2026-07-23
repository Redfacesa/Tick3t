# Tick3t — Agent & development principles

This file guides humans and AI agents working in the Tick3t repository.

## Product doctrine

1. Read [VISION.md](./VISION.md) and [ROADMAP.md](./ROADMAP.md) before large features.
2. Read [ARCHITECTURE.md](./ARCHITECTURE.md) before schema or payment changes.
3. **Tick3t** owns event operations. **RedFace Pay** owns money movement.
4. Never reimplement Paystack, wallets, settlements, or merchant KYC inside Tick3t.
5. Prefer consuming RedFace Pay APIs / `/pay` checkout / shared Supabase RPCs.

## Implementation rules

- Ask: *Does this make running an event easier?* If not, cut scope.
- Stay on the current roadmap phase unless the user explicitly jumps ahead.
- Prefer extending existing `tick3t_*` tables and RPCs over parallel systems.
- Keep the Tick3t Vite app as the canonical UX for tick3t.online; avoid long-term drift with Pay-embedded copies when changing Tick3t behaviour.
- Shared hub migrations live in the RedFace Pay repo (`supabase/migrations`). Apply them to the shared Supabase project; document the migration name in PRs.
- Do not hardcode partner fee splits or platform percentages in the UI — fee logic belongs in the financial engine / merchant settings.
- Auth: Clerk UI + Supabase session (SSO via RedFace Pay when needed). Platform admins are listed in `src/lib/tick3t/admins.ts` and hub `platform_ecosystem_apps`.

## Code style

- Match existing TypeScript / React / Tailwind patterns in this repo.
- Small, focused diffs. No drive-by refactors.
- Use absolute imports via `@/`.
- Tests for pure helpers under `src/lib/tick3t/__tests__/`.

## Do not

- Duplicate payment initiation outside RedFace Pay `init_payment` / checkout URLs.
- Treat Tick3t ticket lines as catalog `products` (they use `ticket_type_id`, not `product_id`).
- Invent marketplace tables before Phase 4+ without an explicit user request.
- Commit secrets or `.env` files.

## When stuck

Re-read VISION north star, then ship the smallest change that strengthens Phase 1 foundations (event workspace, tickets, door ops, finance visibility).
