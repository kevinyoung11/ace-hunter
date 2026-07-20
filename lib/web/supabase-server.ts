import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { loadWebConfig } from "./environment";

export async function createSupabaseServerClient() {
  const config = loadWebConfig(process.env);
  const store = await cookies();
  return createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (items) => {
        try { items.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* Server Components are read-only. */ }
      },
    },
  });
}
