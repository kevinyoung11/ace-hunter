import { GitHubSourceError } from "./github-source.js";

export class RequestBudget {
  private used = 0;
  private waitedMs = 0;
  public constructor(
    private readonly maximumRequests = 300,
    private readonly maximumWaitMs = 60_000,
  ) {
    if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1 || !Number.isSafeInteger(maximumWaitMs) || maximumWaitMs < 0) {
      throw new GitHubSourceError("invalid_request_budget");
    }
  }

  public consumeRequest(): void {
    this.used += 1;
    if (this.used > this.maximumRequests) throw new GitHubSourceError("request_budget_exceeded");
  }

  public allowWait(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || this.waitedMs + milliseconds > this.maximumWaitMs) {
      throw new GitHubSourceError("rate_limit_budget_exceeded");
    }
    this.waitedMs += milliseconds;
  }
}
