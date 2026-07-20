import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, expect, it } from "vitest";
import { verifyAcceptedSkillObservation } from "../../../scripts/accepted-skill-observation.js";

const observationId = "790f10ef-f06b-4ae8-a136-6f1718b5d9ce";
const productId = "7b69d9d3-78c7-4d41-9c15-cfab07f20f6d";
const otherProductId = "cf2cef47-dd8f-4b93-88b4-b3020ea6e729";
const startedAt = new Date("2026-07-20T00:00:00.000Z");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("binds the Skill observation to the normalized requested primary repository and DB facts", async () => {
  const seen: Array<{ text: string; values: unknown[] }> = [];
  await expect(verify(skillPayload(), databaseRow(), " Owner/Repo ", seen)).resolves.toBeUndefined();
  expect(seen).toHaveLength(1);
  expect(seen[0].text).toContain("ace_hunter.product_repositories");
  expect(seen[0].text).toContain("link.is_primary");
  expect(seen[0].values).toEqual([observationId, startedAt]);
});

it("rejects an observation persisted for a different product repository", async () => {
  await expect(verify(skillPayload(), { ...databaseRow(), full_name: "other/repo" }, "owner/repo"))
    .rejects.toThrow("accepted_skill_observation_repository_mismatch");
});

it("rejects a DB observation whose report belongs to a different product ID", async () => {
  await expect(verify(skillPayload(), { ...databaseRow(), product_id: otherProductId }))
    .rejects.toThrow("accepted_skill_observation_facts_mismatch");
});

it.each([
  ["status", (value: ReturnType<typeof skillPayload>) => { value.status = "complete"; }],
  ["completed sources", (value: ReturnType<typeof skillPayload>) => { value.completedSources = ["x"]; }],
  ["missing sources", (value: ReturnType<typeof skillPayload>) => { value.missingSources = []; }],
  ["content", (value: ReturnType<typeof skillPayload>) => { value.content.report.item.productId = otherProductId; }],
])("rejects a Skill observation with tampered %s", async (_name, mutate) => {
  const payload = skillPayload();
  mutate(payload);
  await expect(verify(payload)).rejects.toThrow("accepted_skill_observation_facts_mismatch");
});

function skillPayload() {
  const content = storedContent();
  return {
    kind: "realtime_observation" as const,
    status: "partial" as "complete" | "partial",
    observationId,
    completedSources: ["github"],
    missingSources: ["x"],
    content,
  };
}

function storedContent() {
  return {
    report: {
      outputType: "realtime_observation",
      dataCutoffAt: "2026-07-20T01:00:00.000Z",
      status: "partial",
      item: { productId, name: "Repo", repositoryUrl: "https://github.com/owner/repo" },
      completedSources: ["github"],
      missingSources: ["x"],
    },
  };
}

function databaseRow() {
  return {
    id: observationId,
    product_id: productId,
    status: "partial",
    structured_content: storedContent(),
    full_name: "OWNER/repo",
  };
}

async function verify(
  payload: ReturnType<typeof skillPayload>,
  row = databaseRow(),
  expectedRepository = "owner/repo",
  seen: Array<{ text: string; values: unknown[] }> = [],
) {
  const root = await mkdtemp(join(tmpdir(), "ace-skill-observation-"));
  roots.push(root);
  const artifactPath = join(root, "skill-observe.json");
  await writeFile(artifactPath, JSON.stringify(payload), { mode: 0o600 });
  const pool = {
    query: async (text: string, values: unknown[]) => {
      seen.push({ text, values });
      return { rowCount: 1, rows: [row] };
    },
  } as unknown as Pick<Pool, "query">;
  return verifyAcceptedSkillObservation({ pool, artifactPath, expectedRepository, startedAt });
}
