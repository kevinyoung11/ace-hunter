import { createHash } from "node:crypto";
import { JobCommandStore, type JobCommand } from "../db/stores/job-command-store.js";
import { OpsAuditStore } from "../db/stores/ops-audit-store.js";
import { WorkerHeartbeatStore } from "../db/stores/worker-heartbeat-store.js";
import { JobDefinitionStore } from "../db/stores/job-definition-store.js";
import { validateJobRequest, type Executor } from "./job-catalog.js";

export class CommandService {
  public constructor(private readonly commands: JobCommandStore, private readonly audit?: OpsAuditStore, private readonly heartbeats?: WorkerHeartbeatStore, private readonly definitions?: JobDefinitionStore) {}
  public async enqueue(input:{jobName:string;parameters?:unknown;scheduledFor?:Date;idempotencyKey?:string;commandId?:string;actor?:string}):Promise<JobCommand>{
    const validated=validateJobRequest({name:input.jobName,parameters:input.parameters});
    const key=input.idempotencyKey ?? input.commandId ?? createHash("sha256").update(`${validated.definition.name}|${input.scheduledFor?.toISOString()??"manual"}|${canonical(validated.parameters)}`).digest("hex");
    const command=await this.commands.create({jobName:validated.definition.name,executor:validated.definition.executor,capability:validated.definition.capability,parameters:validated.parameters,idempotencyKey:key,scheduledFor:input.scheduledFor});
    await this.audit?.record({actor:input.actor??"system",action:"enqueue",jobName:command.jobName,commandId:command.id,details:{idempotency_key:key}});
    return command;
  }
  public async claim(workerId:string,executor:Executor,capabilities:string[]){return this.commands.call("claim_job_command",[workerId,executor,capabilities]);}
  public async start(commandId:string,workerId:string){return this.commands.call("start_job_command",[commandId,workerId]);}
  public async bind(commandId:string,workerId:string,jobRunId:string){return this.commands.call("bind_job_run",[commandId,workerId,jobRunId]);}
  public async complete(commandId:string,workerId:string,status:"succeeded"|"partial"|"failed",errorCode?:string,errorMessage?:string){return this.commands.call("complete_job_command",[commandId,workerId,status,errorCode??null,errorMessage??null]);}
  public async cancel(commandId:string,actor:string){return this.commands.call("cancel_job_command",[commandId,actor]);}
  public async requeue(commandId:string,actor:string){return this.commands.call("requeue_job_command",[commandId,actor]);}
  public async retry(commandId:string,actor:string){const result=await this.commands.retry(commandId); if(result) await this.audit?.record({actor,action:"retry",jobName:result.jobName,commandId}); return result;}
  public async setEnabled(jobName:string,enabled:boolean,actor:string){if(!this.definitions) throw new Error("job_definition_store_required"); await this.definitions.setEnabled(jobName,enabled); await this.audit?.record({actor,action:enabled?"enable":"pause",jobName});}
  public async heartbeat(workerId:string,executor:Executor,capabilities:string[],version?:string,metadata?:Record<string,unknown>){
    if (!this.heartbeats) throw new Error("heartbeat_store_required");
    return this.heartbeats.heartbeat({ workerId, executor, capabilities, version, metadata });
  }
}
function canonical(value:unknown):string { if(Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if(value&&typeof value === "object") return `{${Object.keys(value as Record<string,unknown>).sort().map(k=>JSON.stringify(k)+":"+canonical((value as Record<string,unknown>)[k])).join(",")}}`; return JSON.stringify(value); }
