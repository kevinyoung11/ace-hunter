import { createPool } from "../../src/db/client";
import { JobDefinitionStore } from "../../src/db/stores/job-definition-store";
import { JobCommandStore } from "../../src/db/stores/job-command-store";
import { WorkerHeartbeatStore } from "../../src/db/stores/worker-heartbeat-store";
import { OpsAuditStore } from "../../src/db/stores/ops-audit-store";
import { validateJobRequest } from "../../src/ops/job-catalog";
import { loadOpsConfig } from "./environment";
let singleton: OpsService | undefined;
export class OpsService {
  public readonly pool = createPool(loadOpsConfig().ACE_HUNTER_OPS_DATABASE_URL);
  public readonly jobs = new JobDefinitionStore(this.pool); public readonly commands = new JobCommandStore(this.pool); public readonly workers = new WorkerHeartbeatStore(this.pool); public readonly audit = new OpsAuditStore(this.pool);
  async health(){ const r=await this.pool.query("select now() as now"); return { ok:true, database_time:r.rows[0]?.now }; }
  async createCommand(name:string, body:Record<string,unknown>, actor:string){ const parsed=validateJobRequest({name, executor:typeof body.executor==="string"?body.executor as any:undefined, capability:typeof body.capability==="string"?body.capability:undefined, parameters:body.parameters}); const key=typeof body.idempotency_key==="string"?body.idempotency_key:crypto.randomUUID(); const command=await this.commands.create({jobName:parsed.definition.name,executor:parsed.definition.executor,capability:parsed.definition.capability,parameters:parsed.parameters,idempotencyKey:key,scheduledFor:typeof body.scheduled_for==="string"?new Date(body.scheduled_for):undefined}); await this.audit.record({actor,action:"command.create",jobName:name,commandId:command.id}); return command; }
}
export function opsService(): OpsService { return singleton ??= new OpsService(); }
