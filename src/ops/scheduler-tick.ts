import type { JobCommand } from "../db/stores/job-command-store.js";
import type { JobName, Executor } from "./job-catalog.js";
export interface SchedulerDefinition { name: JobName; executor: Executor; capability: string; workflow: string; enabled: boolean; pausedAt?: Date|null; schedule: { minute: number|string; hour: number|string }; parameters: Record<string, unknown> }
export interface SchedulerStore { now(): Promise<Date>; definitions(): Promise<SchedulerDefinition[]>; enqueue(input: { jobName: string; parameters: Record<string, unknown>; scheduledFor: Date; idempotencyKey: string }): Promise<JobCommand> }
export interface ScheduledDispatch { id: string; workflow: string; commandId: string }
export interface SchedulerTickResult { created: number; dispatched: number; observed: boolean; errors: Array<{ jobName: string; code: string }> }
export async function runSchedulerTick(options: { store: SchedulerStore; dispatch: (command: ScheduledDispatch) => Promise<void>; observe?: boolean }): Promise<SchedulerTickResult> {
  const now = await options.store.now(); const definitions = await options.store.definitions();
  const result: SchedulerTickResult = { created: 0, dispatched: 0, observed: Boolean(options.observe), errors: [] };
  const slice = new Date(now); slice.setUTCSeconds(0, 0);
  for (const definition of definitions) {
    if (!definition.enabled || definition.pausedAt || !matches(definition.schedule.minute, slice.getUTCMinutes()) || !matches(definition.schedule.hour, slice.getUTCHours())) continue;
    const idempotencyKey = `schedule:${definition.name}:${slice.toISOString()}`;
    if (options.observe) { result.created += 1; continue; }
    let command: JobCommand;
    try { command = await options.store.enqueue({ jobName: definition.name, parameters: definition.parameters, scheduledFor: slice, idempotencyKey }); result.created += 1; }
    catch (error) { result.errors.push({ jobName: definition.name, code: stableCode(error) }); continue; }
    try { await options.dispatch({ id: command.id, commandId: command.id, workflow: definition.workflow }); result.dispatched += 1; }
    catch (error) { result.errors.push({ jobName: definition.name, code: stableCode(error) }); }
  }
  return result;
}
function matches(rule: number|string, value: number): boolean { return rule === "*" || Number(rule) === value; }
function stableCode(error: unknown): string { const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined; return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "scheduler_error"; }
