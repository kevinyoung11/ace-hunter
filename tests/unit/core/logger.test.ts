import { expect, it } from "vitest";
import { redact } from "../../../src/core/logger.js";

it("redacts URL passwords and authorization values", () => {
  expect(
    redact(
      "postgres://ace:secret@db/x Authorization: Bearer token https://x.test?q=ok&api_key=query-secret dynamic-secret",
      ["dynamic-secret"],
    ),
  ).toBe(
    "postgres://ace:[REDACTED]@db/x Authorization: [REDACTED] https://x.test?q=ok&api_key=[REDACTED] [REDACTED]",
  );
});

it("redacts the complete cookie header including spaced attributes", () => {
  expect(
    redact("Cookie: session=one; auth=two Set-Cookie: sid=three; HttpOnly"),
  ).toBe("Cookie: [REDACTED]");
});

it("redacts every value in cookie headers without crossing line boundaries", () => {
  expect(redact("Cookie: session=secret; csrf=also-secret; theme=dark")).toBe(
    "Cookie: [REDACTED]",
  );
  expect(
    redact("Cookie: session=secret; csrf=also-secret\r\nSet-Cookie: sid=value; HttpOnly"),
  ).toBe("Cookie: [REDACTED]\r\nSet-Cookie: [REDACTED]");
  expect(
    redact("Cookie: session=secret\r\nContent-Type: application/json"),
  ).toBe("Cookie: [REDACTED]\r\nContent-Type: application/json");
  expect(redact("Cookie: session=secret\nX-Request-Id: safe-id")).toBe(
    "Cookie: [REDACTED]\nX-Request-Id: safe-id",
  );
});
