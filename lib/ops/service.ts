import { createPool } from "../../src/db/client";
import { JobDefinitionStore } from "../../src/db/stores/job-definition-store";
import { JobCommandStore } from "../../src/db/stores/job-command-store";
import { WorkerHeartbeatStore } from "../../src/db/stores/worker-heartbeat-store";
import { OpsAuditStore } from "../../src/db/stores/ops-audit-store";
import { validateJobRequest, type Executor } from "../../src/ops/job-catalog";
import { loadOpsConfig } from "./environment";
let singleton: OpsService | undefined;
export class OpsService {
  public readonly pool = createPool(loadOpsConfig().ACE_HUNTER_OPS_DATABASE_URL);
  public readonly jobs = new JobDefinitionStore(this.pool); public readonly commands = new JobCommandStore(this.pool); public readonly workers = new WorkerHeartbeatStore(this.pool); public readonly audit = new OpsAuditStore(this.pool);
  async health(){ const r=await this.pool.query("select now() as now"); return { ok:true, database_time:r.rows[0]?.now }; }
  async createCommand(name:string, body:Record<string,unknown>, actor:string){ const executor = body.executor === "github" || body.executor === "local" ? body.executor as Executor : undefined; const parsed=validateJobRequest({name, executor, capability:typeof body.capability==="string"?body.capability:undefined, parameters:body.parameters}); const key=typeof body.idempotency_key==="string"?body.idempotency_key:crypto.randomUUID(); const command=await this.commands.create({jobName:parsed.definition.name,executor:parsed.definition.executor,capability:parsed.definition.capability,parameters:parsed.parameters,idempotencyKey:key,scheduledFor:typeof body.scheduled_for==="string"?new Date(body.scheduled_for):undefined}); await this.audit.record({actor,action:"command.create",jobName:name,commandId:command.id}); return command; }
  async tick(){ const config=loadOpsConfig(); const now=new Date(); const jobs=await this.jobs.list(); let created=0,dispatched=0; for(const job of jobs){ if(!job.enabled||job.pausedAt) continue; const command=await this.commands.create({jobName:job.name,executor:job.executor,capability:job.capability,parameters:{},idempotencyKey:`schedule:${job.name}:${now.toISOString().slice(0,16)}`,scheduledFor:now}); created++; if(job.executor==="github"&&config.GITHUB_TOKEN&&config.GITHUB_REPOSITORY){const [owner,repo]=config.GITHUB_REPOSITORY.split("/"); const response=await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/ops-command.yml/dispatches`,{method:"POST",headers:{accept:"application/vnd.github+json",authorization:`Bearer ${config.GITHUB_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({ref:"main",inputs:{job_name:job.name,command_id:command.id}})}); if(!response.ok) throw new Error("github_dispatch_failed"); dispatched++;}} return {created,dispatched,at:now.toISOString()}; }
}
export function opsService(): OpsService { return singleton ??= new OpsService(); }
