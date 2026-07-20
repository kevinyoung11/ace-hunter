import { describe, expect, it, afterEach } from "vitest";
import { GET as health } from "../../../app/api/ops/health/route";
import { GET as jobs, POST as createJob } from "../../../app/api/ops/jobs/route";
import { GET as sources } from "../../../app/api/ops/sources/route";
import { POST as jobAction } from "../../../app/api/ops/jobs/[name]/route";

const env = { ...process.env };
afterEach(() => { for (const k of ["ACE_HUNTER_OPS_DATABASE_URL","ACE_HUNTER_OPS_ORIGIN","ACE_HUNTER_OPS_API_TOKEN"]) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } });
describe("protected ops routes", () => {
  it("fails closed when ops secrets are absent", async () => {
    delete process.env.ACE_HUNTER_OPS_DATABASE_URL; delete process.env.ACE_HUNTER_OPS_ORIGIN; delete process.env.ACE_HUNTER_OPS_API_TOKEN;
    const response = await health(new Request("https://ops.example/api/ops/health"));
    expect(response.status).toBe(503); expect((await response.json()).code).toBe("ops_not_configured"); expect(response.headers.get("x-correlation-id")).toBeTruthy();
  });
  it("rejects requests without token", async () => {
    process.env.ACE_HUNTER_OPS_DATABASE_URL="https://db.example/ops"; process.env.ACE_HUNTER_OPS_ORIGIN="https://ops.example"; process.env.ACE_HUNTER_OPS_API_TOKEN="0123456789abcdef";
    const response = await jobs(new Request("https://ops.example/api/ops/jobs", { headers: { origin: "https://ops.example" } }));
    expect(response.status).toBe(401); expect((await response.json()).code).toBe("unauthorized");
  });
  it("rejects cross-origin and oversized mutations before parsing", async () => {
    process.env.ACE_HUNTER_OPS_DATABASE_URL="https://db.example/ops"; process.env.ACE_HUNTER_OPS_ORIGIN="https://ops.example"; process.env.ACE_HUNTER_OPS_API_TOKEN="0123456789abcdef";
    const badOrigin = await sources(new Request("https://ops.example/api/ops/sources", { headers: { origin: "https://evil.example", "x-ops-token": process.env.ACE_HUNTER_OPS_API_TOKEN! } }));
    expect(badOrigin.status).toBe(403);
    const oversized = await createJob(new Request("https://ops.example/api/ops/jobs", { method: "POST", headers: { origin: "https://ops.example", "x-ops-token": process.env.ACE_HUNTER_OPS_API_TOKEN!, "x-csrf-token": process.env.ACE_HUNTER_OPS_API_TOKEN!, "content-length": "70000" }, body: "{}" }));
    expect(oversized.status).toBe(413);
  });
  it("requires explicit confirmation for force-run", async () => {
    process.env.ACE_HUNTER_OPS_DATABASE_URL="https://db.example/ops"; process.env.ACE_HUNTER_OPS_ORIGIN="https://ops.example"; process.env.ACE_HUNTER_OPS_API_TOKEN="0123456789abcdef";
    const response = await jobAction(new Request("https://ops.example/api/ops/jobs/retention", { method:"POST", headers:{origin:"https://ops.example", "x-ops-token":process.env.ACE_HUNTER_OPS_API_TOKEN!, "x-csrf-token":process.env.ACE_HUNTER_OPS_API_TOKEN!, "content-type":"application/json"}, body:JSON.stringify({action:"force-run"}) }), {params:Promise.resolve({name:"retention"})});
    expect(response.status).toBe(400); expect((await response.json()).code).toBe("force_confirmation_required");
  });
  it("bounds chunked request bodies without a content-length", async () => {
    process.env.ACE_HUNTER_OPS_DATABASE_URL="https://db.example/ops"; process.env.ACE_HUNTER_OPS_ORIGIN="https://ops.example"; process.env.ACE_HUNTER_OPS_API_TOKEN="0123456789abcdef";
    const body = new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(70_000)); controller.close();}});
    const response = await createJob(new Request("https://ops.example/api/ops/jobs", {method:"POST", headers:{origin:"https://ops.example", "x-ops-token":process.env.ACE_HUNTER_OPS_API_TOKEN!, "x-csrf-token":process.env.ACE_HUNTER_OPS_API_TOKEN!, "content-type":"application/json"}, body, duplex:"half"} as RequestInit));
    expect(response.status).toBe(413); expect((await response.json()).code).toBe("request_too_large");
  });
});
