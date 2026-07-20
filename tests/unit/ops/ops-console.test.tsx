/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OpsJobs, OpsOverview, OpsWorkers } from "../../../components/ops/ops-console";

vi.mock("next/link", () => ({ default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a> }));

const jobs = { jobs: [{ name: "collect_github_trending", executor: "github", capability: "github.trending.collect", enabled: true, pausedAt: null }] };
afterEach(() => { vi.restoreAllMocks(); });

describe("Ops console states", () => {
  it("renders healthy overview without exposing configuration secrets", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(url.endsWith("health") ? JSON.stringify({ ok: true, database_time: "2026-07-21T00:00:00Z" }) : JSON.stringify(jobs), { status: 200 }))));
    render(<OpsOverview />);
    expect(screen.getAllByRole("status")[0].textContent).toContain("正在读取");
    await waitFor(() => expect(screen.getByText("在线")).toBeTruthy());
    expect(document.body.textContent).not.toContain("ACE_HUNTER_OPS_API_TOKEN");
    expect(document.body.textContent).not.toContain("GITHUB_TOKEN");
  });

  it("shows offline and partial messages when API requests fail", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify({ code: url.endsWith("health") ? "db_down" : "unauthorized" }), { status: 503 }))));
    render(<OpsOverview />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("不可用"));
    expect(screen.getAllByRole("status").some((node) => node.textContent?.includes("部分可用"))).toBe(true);
  });

  it("requires confirmation before pausing or forcing a queued job", async () => {
    const request = vi.fn((url: string) => Promise.resolve(new Response(url.endsWith("/jobs") ? JSON.stringify(jobs) : "{}", { status: 200 })));
    vi.stubGlobal("fetch", request);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<OpsJobs />);
    await waitFor(() => expect(screen.getByText("collect_github_trending")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("暂停任务"));
    expect(request).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "立即运行" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  });

  it("renders stale/queued worker context without claiming success", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ workers: [{ worker_id: "mac-x-1", executor: "local", capabilities: ["x.collect"], status: "stale" }] }), { status: 200 }))));
    render(<OpsWorkers />);
    await waitFor(() => expect(screen.getByText("mac-x-1")).toBeTruthy());
    expect(screen.getByText(/stale/)).toBeTruthy();
  });
});
