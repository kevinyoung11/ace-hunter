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
  async tick(){ const config=loadOpsConfig(); const now=(await this.pool.query<{now:Date}>("select now() as now")).rows[0].now; const minute=now.getUTCMinutes(); const hour=now.getUTCHours(); const schedules:Record<string,[number|string,number|string]>={collect_github_trending:[7,0],discover_github_candidates:[17,"*"],refresh_repo_metrics:[23,"*"],generate_report:[30,0],retention:[45,2],evaluate_success:[15,3]}; let created=0,dispatched=0; for(const job of await this.jobs.list()){ const slot=schedules[job.name]; if(!job.enabled||job.pausedAt||!slot||!(slot[0]==="*"||slot[0]===minute)&&!(slot[1]==="*"||slot[1]===hour)) continue; const command=await this.commands.create({jobName:job.name,executor:job.executor,capability:job.capability,parameters:{},idempotencyKey:`schedule:${job.name}:${now.toISOString().slice(0,16)}`,scheduledFor:now}); created++; if(job.executor==="github"&&config.GITHUB_TOKEN&&config.GITHUB_REPOSITORY){const [owner,repo]=config.GITHUB_REPOSITORY.split("/"); const response=await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/ops-command.yml/dispatches`,{method:"POST",headers:{accept:"application/vnd.github+json",authorization:`Bearer ${config.GITHUB_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({ref:"main",inputs:{job_name:job.name,command_id:command.id}})}); if(!response.ok) throw new Error("github_dispatch_failed"); dispatched++;}} return {created,dispatched,at:now.toISOString()}; }
  async setEnabled(name:string, enabled:boolean){ return this.jobs.setEnabled(name, enabled, "ops-api"); }
  async retry(commandId:string){ return this.commands.retry(commandId, "ops-api"); }
}
export function opsService(): OpsService { return singleton ??= new OpsService(); }
