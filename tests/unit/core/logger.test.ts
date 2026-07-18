import { expect, it } from "vitest";
import { redact } from "../../../src/core/logger.js";

it("redacts URL passwords and authorization values", () => {
  expect(
    redact(
      "postgres://ace:secret@db/x Authorization: Bearer token Cookie: auth=cookie Set-Cookie: sid=value https://x.test?q=ok&api_key=query-secret dynamic-secret",
      ["dynamic-secret"],
    ),
  ).toBe(
    "postgres://ace:[REDACTED]@db/x Authorization: [REDACTED] Cookie: [REDACTED] Set-Cookie: [REDACTED] https://x.test?q=ok&api_key=[REDACTED] [REDACTED]",
  );
});
