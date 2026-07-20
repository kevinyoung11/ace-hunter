"use client";

import { createBrowserClient } from "@supabase/ssr";
import { loadWebConfig } from "./environment";

export function createSupabaseBrowserClient() {
  const config = loadWebConfig(process.env);
  return createBrowserClient(config.supabaseUrl, config.supabasePublishableKey);
}
