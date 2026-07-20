# Vercel Web Console

Set these Vercel environment variables for Preview and Production:

- `ACE_HUNTER_RUNTIME_DATABASE_URL`: the existing Keychain-managed `ace_hunter_runtime` DSN, never `SUPABASE_DB_URL`/`postgres`.
- `ACE_HUNTER_USER_ID`: the existing single Ace Hunter user UUID.
- `NEXT_PUBLIC_SUPABASE_URL`: value of local `SUPABASE_URL`.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: value of local `SUPABASE_ANON_KEY`.

Add `https://<deployment-domain>/auth/callback` to Supabase Auth redirect URLs. Do not commit the source `.env.local`, Keychain values, service-role key, database administrator URL, GitHub token, or Twitter credentials.

The console supports only latest daily report, stored-fact analysis, and monitor management. Real-time observation remains on the local Mac worker.
