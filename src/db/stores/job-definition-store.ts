import type { Queryable } from "./queryable.js";
import type { JobDefinition } from "../../ops/job-catalog.js";
export class JobDefinitionStore {
  public constructor(private readonly db: Queryable) {}
  public async list(): Promise<JobDefinition[]> {
    const r = await this.db.query<{name:string;executor:"github"|"local";capability:string;enabled:boolean;paused_at:Date|null}>("select name,executor,capability,enabled,paused_at from ace_hunter.job_definitions order by name");
    return r.rows.map((x) => ({ name: x.name as JobDefinition["name"], executor:x.executor, capability:x.capability, enabled:x.enabled, pausedAt:x.paused_at }));
  }
  public async setEnabled(name:string, enabled:boolean):Promise<void>{ await this.db.query("update ace_hunter.job_definitions set enabled=$2, paused_at=case when $2 then null else coalesce(paused_at,now()) end, updated_at=now() where name=$1",[name,enabled]); }
}
