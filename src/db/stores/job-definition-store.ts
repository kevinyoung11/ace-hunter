import type { Queryable } from "./queryable.js";
import type { JobDefinition } from "../../ops/job-catalog.js";
export class JobDefinitionStore {
  public constructor(private readonly db: Queryable) {}
  public async list(): Promise<JobDefinition[]> {
    const r = await this.db.query<{name:string;executor:"github"|"local";capability:string;enabled:boolean;paused_at:Date|null}>("select name,executor,capability,enabled,paused_at from ace_hunter.job_definitions order by name");
    return r.rows.map((x) => ({ name: x.name as JobDefinition["name"], executor:x.executor, capability:x.capability, enabled:x.enabled, pausedAt:x.paused_at }));
  }
}
