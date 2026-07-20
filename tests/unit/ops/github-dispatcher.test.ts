import { describe, expect, it, vi } from "vitest";
import { GitHubCommandExecutor, GitHubDispatcher, dispatchGitHubWorkflow } from "../../../src/ops/github-dispatcher.js";
describe("GitHub dispatcher",()=>{
 it("dispatches every catalog command into the durable lifecycle workflow",async()=>{const request=vi.fn(async()=>new Response(null,{status:204})); const commandId="11111111-1111-4111-8111-111111111111"; await dispatchGitHubWorkflow({owner:"o",repo:"r",token:"secret",request},{workflow:"trending.yml",jobName:"collect_github_trending",commandId}); expect(request).toHaveBeenCalledWith("https://api.github.com/repos/o/r/actions/workflows/ops-command.yml/dispatches",expect.objectContaining({method:"POST",body:JSON.stringify({ref:"main",inputs:{job_name:"collect_github_trending",command_id:commandId}})}));});
 it("returns stable dispatch errors and never includes token",async()=>{const request=vi.fn(async()=>new Response("token=secret",{status:500})); const commandId="22222222-2222-4222-8222-222222222222"; const command={workflow:"trending.yml",jobName:"collect_github_trending",commandId} as const; await expect(dispatchGitHubWorkflow({owner:"o",repo:"r",token:"secret",request},command)).rejects.toMatchObject({code:"github_dispatch_failed"}); await expect(dispatchGitHubWorkflow({owner:"o",repo:"r",token:"secret",request},command)).rejects.not.toThrow("secret");});
 it("validates workflow, job and command id before calling GitHub",async()=>{const request=vi.fn(); const dispatcher=new GitHubDispatcher({owner:"o",repo:"r",token:"secret",request}); await expect(dispatcher.dispatch({workflow:"../bad",jobName:"collect_github_trending",commandId:"not-a-command"})).rejects.toMatchObject({code:"validation_error"}); await expect(dispatcher.dispatch({workflow:"trending.yml",jobName:"retention",commandId:"11111111-1111-4111-8111-111111111111"})).rejects.toMatchObject({code:"validation_error"}); expect(request).not.toHaveBeenCalled();});
 it("claims, starts, dispatches, binds and completes a command", async () => {
   const command = { id:"c1", jobName:"collect_github_trending", executor:"github" as const, capability:"github.trending", parameters:{period:"daily"}, status:"queued" as const, idempotencyKey:"k", scheduledFor:new Date("2026-07-21T00:00:00Z"), jobRunId:null };
   const store = { get:vi.fn(async()=>command), claim:vi.fn(async()=>command), start:vi.fn(async()=>command), bind:vi.fn(async()=>command), complete:vi.fn(async()=>command) };
   const dispatcher = vi.fn(async()=>({ kind:"job_run", runId:"run-1", status:"success", executed:true }));
   const result = await new GitHubCommandExecutor(store, dispatcher).execute("c1", "worker-1");
   expect(result).toMatchObject({runId:"run-1",status:"succeeded"});
   expect(store.claim).toHaveBeenCalledWith("c1","worker-1","github",["github.trending"]);
   expect(store.start).toHaveBeenCalledWith("c1","worker-1");
   expect(store.bind).toHaveBeenCalledWith("c1","worker-1","run-1");
   expect(store.complete).toHaveBeenCalledWith("c1","worker-1","succeeded",undefined,undefined);
   expect(dispatcher).toHaveBeenCalledWith(expect.objectContaining({name:"collect_github_trending",commandId:"c1"}));
 });
});
