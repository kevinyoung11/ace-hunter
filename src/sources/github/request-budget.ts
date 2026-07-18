export class RequestBudget {
  private used = 0;
  private waitedMs = 0;
  public constructor(
    private readonly maximumRequests = 300,
    private readonly maximumWaitMs = 60_000,
  ) {
    if (!Number.isInteger(maximumRequests) || maximumRequests < 1 || maximumWaitMs < 0) {
      throw new Error("invalid_request_budget");
    }
  }

  public consumeRequest(): void {
    this.used += 1;
    if (this.used > this.maximumRequests) throw new Error("github_request_budget_exceeded");
  }

  public allowWait(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || this.waitedMs + milliseconds > this.maximumWaitMs) {
      throw new Error("github_rate_limit_budget_exceeded");
    }
    this.waitedMs += milliseconds;
  }
}
