# Ace Hunter Skill-First Homepage and Trending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Skill-first homepage with real GitHub daily, weekly, and monthly trending rankings.

**Architecture:** Add one typed `trending(period)` read method over existing `github_trending_snapshots`, expose it through `/api/trending`, and render it in new homepage components. Move the current report dashboard to `/console` without changing its existing APIs.

**Tech Stack:** Next.js 16, React 19, TypeScript, pg, Vitest, CSS.

---

### Task 1: Read and expose real trending snapshots

**Files:**
- Modify: `src/web/stored-facts-service.ts`
- Create: `app/api/trending/route.ts`
- Create: `tests/unit/web/trending-service.test.ts`
- Create: `tests/integration/web/trending-route.test.ts`

- [ ] **Step 1: Write the failing service test**

```ts
await expect(service.trending("daily")).resolves.toMatchObject({
  kind: "trending", period: "daily",
  items: [{ rank: 1, fullName: "acme/alpha", starsInPeriod: 420, stars: 12000 }],
});
```

- [ ] **Step 2: Verify the test fails**

Run `npm run test:run -- tests/unit/web/trending-service.test.ts`; expect failure because `trending` is absent.

- [ ] **Step 3: Implement the typed query**

Add `TrendingPeriod = "daily" | "weekly" | "monthly"` and `trending(period)`. Query `ace_hunter.github_trending_snapshots` joined to `repositories`, filter to `max(captured_at)` for `$1`, order by `rank`, and return `rank`, `fullName`, `repoUrl`, `language`, `starsInPeriod`, `stars`, `capturedAt`. For zero rows return `{ kind: "not_found", reason: "trending_unavailable", period }`.

- [ ] **Step 4: Write and implement route validation**

```ts
const period = new URL(request.url).searchParams.get("period") ?? "daily";
if (!(["daily", "weekly", "monthly"] as const).includes(period as never)) return failure("invalid_period", 400);
```

Call `webService().trending(period)`; use 404 only for `kind === "not_found"`.

- [ ] **Step 5: Verify and commit**

Run `npm run test:run -- tests/unit/web/trending-service.test.ts tests/integration/web/trending-route.test.ts`; commit `feat: add GitHub trending API`.

### Task 2: Add Skill-first homepage and relocate the console

**Files:**
- Create: `components/home/skill-homepage.tsx`
- Create: `components/home/trending-board.tsx`
- Modify: `app/page.tsx`, `components/console/navigation.tsx`, `app/analyze/page.tsx`, `app/monitors/page.tsx`
- Create: `app/console/page.tsx`

- [ ] **Step 1: Write the empty-state test**

```ts
render(<TrendingBoard initial={{ kind: "not_found", reason: "trending_unavailable", period: "daily" }} />);
expect(screen.getByText("榜单暂不可用")).toBeInTheDocument();
```

- [ ] **Step 2: Implement the homepage composition**

`SkillHomepage` renders one H1, an install Skill primary CTA, a `#trending` secondary CTA, a daily top signal built from the first real record, three existing capability statements, and a `/console` link. `TrendingBoard` fetches `/api/trending?period=<period>` when daily/weekly/monthly is selected and never renders fabricated entries.

- [ ] **Step 3: Move the dashboard**

Render `Navigation` and `TodayReport` in `app/console/page.tsx`. Point Navigation’s brand/report links to `/console`; retain `/analyze` and `/monitors`.

- [ ] **Step 4: Verify and commit**

Run `npm run test:run -- tests/unit/web tests/integration/web`; commit `feat: add Skill-first homepage and console route`.

### Task 3: Apply Swiss layout and ship

**Files:**
- Modify: `app/globals.css`
- Modify: `docs/operations/vercel-web-console.md`

- [ ] **Step 1: Replace visual tokens**

Use `#F7F7F8` surface, `#151515` ink, `#6D6D6D` muted, `#D8D8DA` rules, and `#002FA7` as the only accent. Use sans-serif type only; remove terminal green, glow, gradients, rounded cards, and shadows.

- [ ] **Step 2: Implement responsive ranking layout**

Use a 12-column desktop hero and editorial ranking rows. Stack the hero at 768px. At 390px preserve period controls and transform ranking rows into two readable lines without horizontal overflow.

- [ ] **Step 3: Verify and deploy**

Run `npm run lint && npm run typecheck && npm run build:web`; capture `/` at 1440px, 768px, and 390px. Verify `daily`, `weekly`, and `monthly` through the deployed API and document their status. Commit `feat: apply Swiss Skill-first homepage`.

## Self-review

- Task 1 covers real snapshot selection, input validation, typed empty state, and API tests.
- Task 2 covers the confirmed information architecture and preserves the console.
- Task 3 covers visual fidelity, responsive acceptance, and production verification.
