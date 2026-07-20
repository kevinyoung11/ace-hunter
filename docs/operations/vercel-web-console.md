# Vercel Web Console

Set these Vercel environment variables for Preview and Production:

- `ACE_HUNTER_RUNTIME_DATABASE_URL`: the existing Keychain-managed `ace_hunter_runtime` DSN, never `SUPABASE_DB_URL`/`postgres`.
- `ACE_HUNTER_USER_ID`: the existing single Ace Hunter user UUID.
- `NEXT_PUBLIC_SUPABASE_URL`: value of local `SUPABASE_URL`.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: value of local `SUPABASE_ANON_KEY`.

Add `https://<deployment-domain>/auth/callback` to Supabase Auth redirect URLs. Do not commit the source `.env.local`, Keychain values, service-role key, database administrator URL, GitHub token, or Twitter credentials.

## Routes and real-data boundaries

- `/` is the public Skill-first research homepage. Its Daily/Weekly/Monthly GitHub ranking board reads persisted snapshots only; it never invents fallback repositories.
- `/console` is the existing single-user report, analysis, and monitor console.
- `GET /api/trending?period=daily|weekly|monthly` returns the latest captured ranking for that period. A missing capture is a safe `404` `trending_unavailable` response, not mock data.
- `GET /api/today` returns the latest persisted daily report. Real-time collection and database writes remain on the local Mac worker.

## Production verification

After a production deployment, verify the public alias with no credentials:

```bash
curl -fsS https://<production-domain>/
curl -fsS 'https://<production-domain>/api/today'
curl -fsS 'https://<production-domain>/api/trending?period=daily'
curl -fsS 'https://<production-domain>/api/trending?period=weekly'
curl -fsS 'https://<production-domain>/api/trending?period=monthly'
```

All five requests must return `200`. The three trending payloads must have `kind: "trending"`, the requested `period`, and the captured repository records. Check `/` at 1440 px, 768 px, and 390 px: the ranking remains factual and the tabs stay operable with keyboard arrows.
