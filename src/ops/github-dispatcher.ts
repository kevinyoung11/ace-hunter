export interface GitHubDispatchCommand { workflow: string; commandId: string }
export interface GitHubDispatcherOptions { owner: string; repo: string; token: string; ref?: string; request?: typeof fetch }
const workflowPattern = /^[A-Za-z0-9_.-]+\.yml$/;
const commandPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function dispatchGitHubWorkflow(options: GitHubDispatcherOptions, command: GitHubDispatchCommand): Promise<void> {
  if (!workflowPattern.test(command.workflow) || !commandIdValid(command.commandId)) throw Object.assign(new Error("invalid dispatch request"), { code: "validation_error" });
  const request = options.request ?? fetch;
  const response = await request(`https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/actions/workflows/${encodeURIComponent(command.workflow)}/dispatches`, {
    method: "POST", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${options.token}`, "content-type": "application/json", "user-agent": "ace-hunter-ops" },
    body: JSON.stringify({ ref: options.ref ?? "main", inputs: { command_id: command.commandId } }),
  });
  if (!response.ok) throw Object.assign(new Error(`github dispatch failed (${response.status})`), { code: "github_dispatch_failed", status: response.status });
}
export class GitHubDispatcher {
  public constructor(private readonly options: GitHubDispatcherOptions) {}
  public dispatch(command: GitHubDispatchCommand): Promise<void> { return dispatchGitHubWorkflow(this.options, command); }
}
function commandIdValid(id: string): boolean { return commandPattern.test(id); }
