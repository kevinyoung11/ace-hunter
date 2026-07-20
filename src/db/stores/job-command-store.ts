import type { Queryable } from "./queryable.js";
import type { Executor } from "../../ops/job-catalog.js";
export type CommandStatus = "queued"|"claimed"|"running"|"succeeded"|"partial"|"failed"|"cancelled";
export interface JobCommand { id:string; jobName:string; executor:Executor; capability:string; parameters:Record<string,unknown>; status:CommandStatus; idempotencyKey:string; scheduledFor:Date|null; jobRunId:string|null }
type Row = {id:string;job_name:string;executor:Executor;capability:string;parameters:Record<string,unknown>;status:CommandStatus;idempotency_key:string;scheduled_for:Date|null;job_run_id:string|null};
const map=(r:Row):JobCommand=>({id:r.id,jobName:r.job_name,executor:r.executor,capability:r.capability,parameters:r.parameters,status:r.status,idempotencyKey:r.idempotency_key,scheduledFor:r.scheduled_for,jobRunId:r.job_run_id});
export class JobCommandStore {
  public constructor(private readonly db: Queryable) {}
  public async get(commandId:string):Promise<JobCommand|null>{ const r=await this.db.query<Row>(`select * from ace_hunter.get_job_command($1)`,[commandId]); return r.rows[0]?map(r.rows[0]):null; }
  public async claim(commandId:string,workerId:string,executor:Executor,capabilities:string[]):Promise<JobCommand|null>{ return this.call("claim_job_command_by_id",[commandId,workerId,executor,capabilities]); }
  public async start(commandId:string,workerId:string):Promise<JobCommand|null>{ return this.call("start_job_command",[commandId,workerId]); }
  public async bind(commandId:string,workerId:string,jobRunId:string):Promise<JobCommand|null>{ return this.call("bind_job_run",[commandId,workerId,jobRunId]); }
  public async complete(commandId:string,workerId:string,status:CommandStatus,errorCode?:string,errorMessage?:string):Promise<JobCommand|null>{ return this.call("complete_job_command",[commandId,workerId,status,errorCode??null,errorMessage??null]); }
  public async create(input:{jobName:string;executor:Executor;capability:string;parameters:Record<string,unknown>;idempotencyKey:string;scheduledFor?:Date}):Promise<JobCommand>{
    const r=await this.db.query<Row>(`select * from ace_hunter.create_job_command($1,$2,$3,$4::jsonb,$5,$6)`,[input.jobName,input.executor,input.capability,JSON.stringify(input.parameters),input.idempotencyKey,input.scheduledFor??null]);
    return map(r.rows[0]);
  }
  public async retry(commandId:string,actor:string):Promise<JobCommand|null>{ return this.call("retry_job_command",[commandId,actor]); }
  public async lineageReady(commandId:string):Promise<boolean>{ const r=await this.db.query<{ready:boolean}>(`select ace_hunter.x_lineage_ready($1) ready`,[commandId]); return r.rows[0]?.ready===true; }
  public async call(fn:string,args:unknown[]):Promise<JobCommand|null>{ const allowed=new Set(["claim_job_command","claim_job_command_by_id","start_job_command","bind_job_run","complete_job_command","cancel_job_command","requeue_job_command","retry_job_command"]); if(!allowed.has(fn)) throw new Error("unsupported_command_function"); const r=await this.db.query<Row>(`select * from ace_hunter.${fn}(${args.map((_,i)=>`$${i+1}`).join(",")})`,args); return r.rows[0]?map(r.rows[0]):null; }
}
