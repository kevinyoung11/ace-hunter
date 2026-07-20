import type { Queryable } from "./queryable.js";
import type { Executor } from "../../ops/job-catalog.js";
export type CommandStatus = "queued"|"claimed"|"running"|"succeeded"|"partial"|"failed"|"cancelled";
export interface JobCommand { id:string; jobName:string; executor:Executor; capability:string; parameters:Record<string,unknown>; status:CommandStatus; idempotencyKey:string; scheduledFor:Date|null; jobRunId:string|null }
type Row = {id:string;job_name:string;executor:Executor;capability:string;parameters:Record<string,unknown>;status:CommandStatus;idempotency_key:string;scheduled_for:Date|null;job_run_id:string|null};
const cols="id,job_name,executor,capability,parameters,status,idempotency_key,scheduled_for,job_run_id";
const map=(r:Row):JobCommand=>({id:r.id,jobName:r.job_name,executor:r.executor,capability:r.capability,parameters:r.parameters,status:r.status,idempotencyKey:r.idempotency_key,scheduledFor:r.scheduled_for,jobRunId:r.job_run_id});
export class JobCommandStore {
  public constructor(private readonly db: Queryable) {}
  public async create(input:{jobName:string;executor:Executor;capability:string;parameters:Record<string,unknown>;idempotencyKey:string;scheduledFor?:Date}):Promise<JobCommand>{
    const r=await this.db.query<Row>(`insert into ace_hunter.job_commands(job_name,executor,capability,parameters,idempotency_key,scheduled_for) values($1,$2,$3,$4::jsonb,$5,$6) on conflict(idempotency_key) do update set idempotency_key=excluded.idempotency_key returning ${cols}`,[input.jobName,input.executor,input.capability,JSON.stringify(input.parameters),input.idempotencyKey,input.scheduledFor??null]);
    return map(r.rows[0]);
  }
  public async retry(commandId:string):Promise<JobCommand|null>{ const r=await this.db.query<Row>(`update ace_hunter.job_commands set status='queued',claimed_by=null,lease_until=null,started_at=null,finished_at=null,error_code=null,error_message=null,updated_at=now() where id=$1 and status in ('failed','partial') returning ${cols}`,[commandId]); return r.rows[0]?map(r.rows[0]):null; }
  public async call(fn:string,args:unknown[]):Promise<JobCommand|null>{ const allowed=new Set(["claim_job_command","start_job_command","bind_job_run","complete_job_command","cancel_job_command","requeue_job_command"]); if(!allowed.has(fn)) throw new Error("unsupported_command_function"); const r=await this.db.query<Row>(`select * from ace_hunter.${fn}(${args.map((_,i)=>`$${i+1}`).join(",")})`,args); return r.rows[0]?map(r.rows[0]):null; }
}
