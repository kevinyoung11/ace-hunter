import { readFile } from "node:fs/promises";
import { z } from "zod";

const monitorSchema = z.object({
  monitorId: z.string().uuid(),
  productId: z.string().uuid(),
  name: z.string().min(1),
  status: z.enum(["active", "inactive", "paused"]),
  startedAt: z.string().datetime({ offset: true }),
  lastObservedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
const monitorListSchema = z.object({ monitors: z.array(monitorSchema) }).strict();
const observationSchema = z.object({
  kind: z.literal("realtime_observation"),
  status: z.enum(["complete", "partial"]),
  observationId: z.string().uuid(),
  completedSources: z.array(z.string().min(1)),
  missingSources: z.array(z.string().min(1)),
  content: z.object({}).passthrough(),
}).passthrough();

try {
  const paths = process.argv.slice(2);
  if (paths.length !== 3) throw new Error("codex_skill_output_usage_error");
  const [directListPath, skillListPath, skillObservePath] = paths;
  const [directList, skillList] = await Promise.all([
    parseList(directListPath), parseList(skillListPath),
  ]);
  if (JSON.stringify(canonical(directList)) !== JSON.stringify(canonical(skillList))) {
    throw new Error("skill_list_mismatch");
  }
  try {
    observationSchema.parse(JSON.parse((await readFile(skillObservePath, "utf8")).trim()));
  } catch {
    throw new Error("invalid_skill_observe_payload");
  }
  process.stdout.write("codex_skill_output_validation_passed\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "codex_skill_output_validation_failed"}\n`);
  process.exitCode = 1;
}

async function parseList(path: string) {
  try {
    return monitorListSchema.parse(JSON.parse((await readFile(path, "utf8")).trim()));
  } catch {
    throw new Error("invalid_skill_list_payload");
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
