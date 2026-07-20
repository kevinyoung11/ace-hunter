import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { z } from "zod";

const sources = z.enum(["github", "x"]);
const sourceList = z.array(sources).max(2).refine((value) => new Set(value).size === value.length);
const reportSchema = z.object({
  outputType: z.literal("realtime_observation"),
  status: z.enum(["complete", "partial"]),
  item: z.object({ productId: z.string().uuid() }).passthrough(),
  completedSources: sourceList,
  missingSources: sourceList,
}).passthrough();
const contentSchema = z.object({ report: reportSchema }).passthrough();
const skillObservationSchema = z.object({
  kind: z.literal("realtime_observation"),
  status: z.enum(["complete", "partial"]),
  observationId: z.string().uuid(),
  completedSources: sourceList,
  missingSources: sourceList,
  content: contentSchema,
}).strict();

interface ObservationRow {
  id: string;
  product_id: string;
  status: string;
  structured_content: unknown;
  full_name: string;
}

export interface AcceptedSkillObservationOptions {
  pool: Pick<Pool, "query">;
  artifactPath: string;
  expectedRepository: string;
  startedAt: Date;
}

export async function verifyAcceptedSkillObservation(options: AcceptedSkillObservationOptions): Promise<void> {
  const expectedRepository = normalizeFullName(options.expectedRepository);
  if (!Number.isFinite(options.startedAt.getTime())) throw new Error("accepted_skill_observation_started_at_invalid");
  let skillObservation: z.infer<typeof skillObservationSchema>;
  try {
    skillObservation = skillObservationSchema.parse(JSON.parse(await readFile(options.artifactPath, "utf8")));
  } catch {
    throw new Error("accepted_skill_observation_payload_invalid");
  }
  const persisted = await options.pool.query<ObservationRow>(`/* accepted_skill_observation_facts */
    select output.id,output.product_id,output.status,output.structured_content,repository.full_name
    from ace_hunter.analysis_outputs output
    join ace_hunter.product_repositories link on link.product_id=output.product_id and link.is_primary
    join ace_hunter.repositories repository on repository.id=link.repository_id
    where output.id=$1 and output.output_type='realtime_observation'
      and output.created_at >= $2`, [skillObservation.observationId, options.startedAt]);
  if (persisted.rows.length !== 1) throw new Error("missing_skill_realtime_observation");
  const row = persisted.rows[0];
  if (normalizeFullName(row.full_name) !== expectedRepository) {
    throw new Error("accepted_skill_observation_repository_mismatch");
  }
  let storedContent: z.infer<typeof contentSchema>;
  try {
    storedContent = contentSchema.parse(row.structured_content);
  } catch {
    throw new Error("accepted_skill_observation_database_facts_invalid");
  }
  const report = storedContent.report;
  if (row.product_id !== report.item.productId ||
      skillObservation.status !== row.status || skillObservation.status !== report.status ||
      !same(skillObservation.completedSources, report.completedSources) ||
      !same(skillObservation.missingSources, report.missingSources) ||
      !same(skillObservation.content, storedContent)) {
    throw new Error("accepted_skill_observation_facts_mismatch");
  }
}

function normalizeFullName(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(normalized)) {
    throw new Error("accepted_skill_observation_repository_invalid");
  }
  return normalized;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
