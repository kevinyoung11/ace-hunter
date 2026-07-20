import { describe, expect, it } from "vitest";
import { loadWebConfig } from "../../../lib/web/environment.js";

describe("loadWebConfig", () => {
  it("requires the server database URL", () => {
    expect(() => loadWebConfig({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
      ACE_HUNTER_USER_ID: "11111111-1111-4111-8111-111111111111",
    })).toThrow("ACE_HUNTER_RUNTIME_DATABASE_URL");
  });
});
