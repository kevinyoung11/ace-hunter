import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("accepts an equivalent monitor list and a structured realtime observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-codex-output-"));
  roots.push(root);
  const directList = join(root, "direct-list.json");
  const skillList = join(root, "skill-list.json");
  const skillObserve = join(root, "skill-observe.json");
  await writeFile(directList, JSON.stringify({ monitors: [{ monitorId: "74cbda04-ee7c-45e1-a367-03b5b00e0c58", productId: "7b69d9d3-78c7-4d41-9c15-cfab07f20f6d", name: "Repo", status: "active", startedAt: "2026-07-20T00:00:00.000Z", lastObservedAt: null }] }));
  await writeFile(skillList, JSON.stringify({ monitors: [{ status: "active", name: "Repo", productId: "7b69d9d3-78c7-4d41-9c15-cfab07f20f6d", monitorId: "74cbda04-ee7c-45e1-a367-03b5b00e0c58", lastObservedAt: null, startedAt: "2026-07-20T00:00:00.000Z" }] }));
  await writeFile(skillObserve, JSON.stringify({
    kind: "realtime_observation", status: "partial", observationId: "790f10ef-f06b-4ae8-a136-6f1718b5d9ce",
    completedSources: ["github"], missingSources: ["x"], content: { report: { outputType: "realtime_observation" } },
  }));

  const result = validate(directList, skillList, skillObserve);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("codex_skill_output_validation_passed\n");
});

it("rejects a Skill list that is not the direct CLI result", async () => {
  const paths = await fixtures({
    directList: { monitors: [] },
    skillList: { monitors: [{
      monitorId: "74cbda04-ee7c-45e1-a367-03b5b00e0c58",
      productId: "7b69d9d3-78c7-4d41-9c15-cfab07f20f6d",
      name: "Repo", status: "active", startedAt: "2026-07-20T00:00:00.000Z", lastObservedAt: null,
    }] },
  });
  const result = validate(...paths);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("skill_list_mismatch\n");
});

it.each([
  ["empty object", {}],
  ["wrong kind", { kind: "product_analysis", status: "complete", observationId: "790f10ef-f06b-4ae8-a136-6f1718b5d9ce", completedSources: [], missingSources: [], content: {} }],
  ["missing side-effect id", { kind: "realtime_observation", status: "complete", completedSources: ["github", "x"], missingSources: [], content: {} }],
])("rejects a semantically invalid observation: %s", async (_name, skillObserve) => {
  const paths = await fixtures({ directList: { monitors: [] }, skillList: { monitors: [] }, skillObserve });
  const result = validate(...paths);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("invalid_skill_observe_payload\n");
});

function validate(directList: string, skillList: string, skillObserve: string) {
  return spawnSync(process.execPath, [
    "--import", "tsx", "scripts/validate-codex-skill-output.ts", directList, skillList, skillObserve,
  ], { cwd: process.cwd(), encoding: "utf8" });
}

async function fixtures(overrides: {
  directList?: unknown; skillList?: unknown; skillObserve?: unknown;
}): Promise<[string, string, string]> {
  const root = await mkdtemp(join(tmpdir(), "ace-codex-output-"));
  roots.push(root);
  const paths = [join(root, "direct-list.json"), join(root, "skill-list.json"), join(root, "skill-observe.json")] as const;
  const observation = {
    kind: "realtime_observation", status: "complete", observationId: "790f10ef-f06b-4ae8-a136-6f1718b5d9ce",
    completedSources: ["github", "x"], missingSources: [], content: { report: {} },
  };
  await Promise.all([
    writeFile(paths[0], JSON.stringify(overrides.directList ?? { monitors: [] })),
    writeFile(paths[1], JSON.stringify(overrides.skillList ?? { monitors: [] })),
    writeFile(paths[2], JSON.stringify(overrides.skillObserve ?? observation)),
  ]);
  return [...paths];
}
