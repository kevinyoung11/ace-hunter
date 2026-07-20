import { createPool } from "../../src/db/client";
import { JobDefinitionStore } from "../../src/db/stores/job-definition-store";
import { JobCommandStore } from "../../src/db/stores/job-command-store";
import { WorkerHeartbeatStore } from "../../src/db/stores/worker-heartbeat-store";
import { OpsAuditStore } from "../../src/db/stores/ops-audit-store";
import { validateJobRequest, type Executor } from "../../src/ops/job-catalog";
import { runSchedulerTick } from "../../src/ops/scheduler-tick";
import { GitHubDispatcher } from "../../src/ops/github-dispatcher";
import { loadOpsConfig } from "./environment";
let singleton: OpsService | undefined;
export class OpsService {
  public readonly pool = createPool(loadOpsConfig().ACE_HUNTER_OPS_DATABASE_URL);
  public readonly jobs = new JobDefinitionStore(this.pool); public readonly commands = new JobCommandStore(this.pool); public readonly workers = new WorkerHeartbeatStore(this.pool); public readonly audit = new OpsAuditStore(this.pool);
  async health(){ const r=await this.pool.query("select now() as now"); return { ok:true, database_time:r.rows[0]?.now }; }
  async createCommand(name:string, body:Record<string,unknown>, actor:string){ const executor = body.executor === "github" || body.executor === "local" ? body.executor as Executor : undefined; const parsed=validateJobRequest({name, executor, capability:typeof body.capability==="string"?body.capability:undefined, parameters:body.parameters}); const key=typeof body.idempotency_key==="string"?body.idempotency_key:crypto.randomUUID(); const command=await this.commands.create({jobName:parsed.definition.name,executor:parsed.definition.executor,capability:parsed.definition.capability,parameters:parsed.parameters,idempotencyKey:key,scheduledFor:typeof body.scheduled_for==="string"?new Date(body.scheduled_for):undefined}); await this.audit.record({actor,action:"command.create",jobName:name,commandId:command.id}); return command; }
  async tick(){
    const config=loadOpsConfig();
    const schedules: Record<string,{minute:number|string;hour:number|string}> = {
      discover_github_candidates:{minute:17,hour:"*"}, collect_github_trending:{minute:7,hour:0},
      refresh_repo_metrics:{minute:23,hour:"*"}, collect_x_posts:{minute:11,hour:"*"},
      analyze_x_posts:{minute:19,hour:"*"}, collect_x_comments:{minute:29,hour:"*"},
      generate_report:{minute:30,hour:0}, evaluate_success:{minute:15,hour:3}, retention:{minute:45,hour:2},
    };
    const jobs=await this.jobs.list();
    const result=await runSchedulerTick({
      store:{
        now:async()=> (await this.pool.query<{now:Date}>("select now() as now")).rows[0].now,
        definitions:async()=>jobs.map(job=>({...job,schedule:schedules[job.name] ?? {minute:"*",hour:"*"},parameters:{}})),
        enqueue:async input=>this.commands.create({jobName:input.jobName,executor:jobs.find(j=>j.name===input.jobName)!.executor,capability:jobs.find(j=>j.name===input.jobName)!.capability,parameters:input.parameters,idempotencyKey:input.idempotencyKey,scheduledFor:input.scheduledFor}),
      },
      dispatch:async dispatch=>{
        const job=jobs.find(j=>j.name===dispatch.jobName); if(!job || job.executor!=="github") return;
        if(!config.GITHUB_TOKEN || !config.GITHUB_REPOSITORY) return;
        const [owner,repo]=config.GITHUB_REPOSITORY.split("/");
        await new GitHubDispatcher({owner,repo,token:config.GITHUB_TOKEN}).dispatch({workflow:dispatch.workflow,jobName:dispatch.jobName,commandId:dispatch.commandId});
      },
    });
    return result;
  }
  async setEnabled(name:string, enabled:boolean){ return this.jobs.setEnabled(name, enabled, "ops-api"); }
  async retry(commandId:string){ return this.commands.retry(commandId, "ops-api"); }
}
export function opsService(): OpsService { return singleton ??= new OpsService(); }
