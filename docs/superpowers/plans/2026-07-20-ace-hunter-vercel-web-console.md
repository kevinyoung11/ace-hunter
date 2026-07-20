# Ace Hunter Vercel Web Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Vercel-deployable, single-user console for real daily reports, stored-fact project analysis, and monitor management.

**Architecture:** Next.js App Router pages and Route Handlers live in this repository. Each handler validates a Supabase Auth session and requires the configured owner UUID before it calls a `pg`-backed adapter that reuses existing report, resolution, analysis and monitor behavior. The browser never sees a database URL or calls a Supabase Data API.

**Tech Stack:** Next.js, React, TypeScript, PostgreSQL `pg`, Zod, Supabase SSR/Auth, Vitest, Playwright.

---

## File structure

- Create `app/**` for protected console routes, login callback and JSON Route Handlers.
- Create `components/console/**` for accessible report, analysis and monitor UI.
- Create `lib/web/**` for config, Supabase clients, owner authorization, response DTOs and the database service singleton.
- Create `src/web/stored-facts-service.ts` and move only reusable stored-facts behavior out of `src/cli/runtime-dependencies.ts`.
- Create `tests/unit/web/**`, `tests/integration/web/**`, `tests/e2e/web-console.spec.ts`, `playwright.config.ts` and deployment docs.
- Modify `package.json`, `tsconfig.json`, `eslint.config.js`, `.gitignore`, `README.md` and add `.env.example` and `vercel.json`.

### Task 1: Establish the Next.js and Vercel runtime

**Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `.gitignore`, `.env.example`, `vercel.json`, `lib/web/environment.ts`, `tests/unit/web/environment.test.ts`.

- [ ] Write `environment.test.ts` asserting `loadWebConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "key" })` throws `ACE_HUNTER_RUNTIME_DATABASE_URL`, and a complete config returns a frozen object without copying secrets to public keys.
- [ ] Run `npm run test:run -- tests/unit/web/environment.test.ts`; expect module-not-found failure.
- [ ] Run `npm install next@latest react@latest react-dom@latest @supabase/ssr@latest @supabase/supabase-js@latest && npm install -D @types/react@latest @types/react-dom@latest @playwright/test@latest @testing-library/react@latest @testing-library/user-event@latest jsdom@latest`.
- [ ] Implement `loadWebConfig` with a Zod schema for `ACE_HUNTER_RUNTIME_DATABASE_URL`, UUID `ACE_HUNTER_USER_ID`, `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; use key-only errors. Configure JSX, Next scripts (`dev:web`, `build:web`, `test:web`, `test:e2e:web`), `.env.local` ignore, a Node.js 22 Vercel runtime, and non-secret `.env.example` names.
- [ ] Run `npm run test:run -- tests/unit/web/environment.test.ts && npm run typecheck`; expect pass. Commit `feat: add Vercel web runtime foundation`.

### Task 2: Share stored-facts business operations without shelling out

**Files:** `src/web/stored-facts-service.ts`, `src/cli/runtime-dependencies.ts`, `tests/unit/web/stored-facts-service.test.ts`.

- [ ] Write tests where `service.analyze("same-name")` returns `{ kind: "ambiguous", candidates }` unchanged and `service.follow("owner/repo")` writes `{ userId: OWNER_ID, status: "active" }` through the monitor dependency.
- [ ] Run `npm run test:run -- tests/unit/web/stored-facts-service.test.ts`; expect failure.
- [ ] Export `createStoredFactsService({ pool, userId, now })` with only `today`, `analyze`, `listMonitors`, `follow`, `unfollow`. Reuse `resolveProduct`, `analyzeProduct`, `AnalysisOutputStore`, product report construction, monitor transaction and audit writes. Keep GitHub creation and all observe/Twitter dependencies in the CLI runtime only.
- [ ] Run `npm run test:run -- tests/unit/web/stored-facts-service.test.ts tests/integration/cli/commands.test.ts tests/unit/products/analyze-product.test.ts tests/unit/products/monitor-product.test.ts`; expect pass. Commit `refactor: share stored facts service with web`.

### Task 3: Add Supabase Auth and the single-owner gate

**Files:** `lib/web/supabase-server.ts`, `lib/web/supabase-browser.ts`, `lib/web/auth.ts`, `middleware.ts`, `app/login/page.tsx`, `app/auth/callback/route.ts`, `tests/unit/web/auth.test.ts`.

- [ ] Write tests that a no-user client rejects with `{ code: "unauthenticated" }`, and a signed-in but different UUID rejects with `{ code: "forbidden" }`.
- [ ] Run `npm run test:run -- tests/unit/web/auth.test.ts`; expect failure.
- [ ] Use `@supabase/ssr` cookie clients. Implement `requireOwner` with server user lookup and timing-safe UUID comparison against `ACE_HUNTER_USER_ID`. Middleware refreshes sessions; redirects unauthenticated HTML routes to `/login` but allows APIs to return JSON 401/403. Login requests a magic link whose callback exchanges its code and redirects to `/`.
- [ ] Run `npm run test:run -- tests/unit/web/auth.test.ts && npm run typecheck`; expect pass. Commit `feat: protect console with single-user Supabase auth`.

### Task 4: Add authenticated JSON APIs

**Files:** `lib/web/api.ts`, `lib/web/service.ts`, `app/api/today/route.ts`, `app/api/analyze/route.ts`, `app/api/monitors/route.ts`, `tests/integration/web/api-routes.test.ts`.

- [ ] Write API tests: empty `{ target: "   " }` gives `400 { code: "invalid_target" }`; an ambiguous analysis gives 200 candidates; owner checks occur before service calls; unavailable daily report gives `404 { kind: "not_found", reason: "daily_report_unavailable" }`.
- [ ] Run `npm run test:run -- tests/integration/web/api-routes.test.ts`; expect failure.
- [ ] Implement safe JSON serialization and error envelopes, a 16 KiB JSON request cap and Zod target validation (trimmed length 1–512). Use a module-scoped server-side pool and `createStoredFactsService`. Mark handlers `runtime = "nodejs"`; implement `GET /api/today`, `POST /api/analyze`, and `GET`/`POST`/`DELETE /api/monitors`. No handler returns errors, stack traces, rendered markdown or secrets.
- [ ] Run `npm run test:run -- tests/integration/web/api-routes.test.ts && npm run lint && npm run typecheck`; expect pass. Commit `feat: add authenticated Ace Hunter API routes`.

### Task 5: Implement the real-data console UI

**Files:** `app/layout.tsx`, `app/globals.css`, `app/page.tsx`, `app/analyze/page.tsx`, `app/monitors/page.tsx`, `components/console/navigation.tsx`, `components/console/status-badge.tsx`, `components/console/report-item.tsx`, `components/console/analyze-form.tsx`, `components/console/monitor-manager.tsx`, `tests/unit/web/console-components.test.tsx`.

- [ ] Write tests that `StatusBadge` displays `部分数据：X 不可用` for a partial report and `AnalyzeForm` turns an ambiguous response into selectable named candidates rather than choosing one.
- [ ] Run `npm run test:run -- tests/unit/web/console-components.test.tsx`; expect failure.
- [ ] Build the responsive editorial dashboard: report cutoff, coverage/status, summary, ranked items, facts, risks and evidence links; analysis and monitor forms must show loading, success, no result, failure, unavailable and ambiguity states. Use no Mock data. Represent unavailable X data as unavailable, never zero.
- [ ] Run `npm run test:run -- tests/unit/web/console-components.test.tsx && npm run build:web`; expect pass. Commit `feat: build Ace Hunter web console`.

### Task 6: Document deployment and prove behavior

**Files:** `playwright.config.ts`, `tests/e2e/web-console.spec.ts`, `docs/operations/vercel-web-console.md`, `README.md`.

- [ ] Write a Playwright test using API interception: an owner sees the daily report, reaches Project Analysis, submits `owner/repo`, sees results, and can change a monitor; an intercepted 403 renders the denial state.
- [ ] Run `npm run test:e2e:web`; expect failure until web-server configuration exists.
- [ ] Configure a credential-free local Playwright fixture. Document Vercel’s exact non-secret mapping: `SUPABASE_DB_URL → ACE_HUNTER_RUNTIME_DATABASE_URL`, `SUPABASE_URL → NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ANON_KEY → NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, plus separately supplied `ACE_HUNTER_USER_ID`; specify Supabase redirect URLs and preview/production smoke checks. Do not commit the supplied `.env.local` or credentials.
- [ ] Run `npm run test:run && npm run lint && npm run typecheck && npm run build:web && npm run test:e2e:web`. Run database integration tests only after explicit loopback `ACE_TEST_*` URLs are provisioned; the supplied cloud `SUPABASE_DB_URL` must not be repurposed as a destructive test database.
- [ ] Commit `docs: add Vercel console deployment guide`.

## Self-review

Tasks 1–3 cover deployment configuration and one-user authentication; Tasks 2 and 4 preserve only today/analyze/monitor behavior, deliberately excluding observe; Task 5 covers all real-data UI states; Task 6 covers no-secret deployment and browser verification. Interfaces consistently use `createStoredFactsService` and existing command-output discriminants.
