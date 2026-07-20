// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillHomepage } from "../../../components/home/skill-homepage";
import { TrendingBoard } from "../../../components/home/trending-board";

const dailyTopSignal = {
  id: "prompt-saver",
  name: "Prompt Saver",
  description: "保存可复用的提示词。",
  language: "TypeScript",
  href: "https://example.com/prompt-saver",
  rank: 1,
  starsInPeriod: 42,
  stars: 1_200,
  capturedAt: "2026-07-21T08:30:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SkillHomepage", () => {
  it("presents the skill-first actions and the supplied daily top signal", () => {
    render(<SkillHomepage dailyTopSignal={dailyTopSignal} />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("找到值得安装的 Skill");
    expect(screen.getByRole("link", { name: "安装 Skill" }).getAttribute("href")).toBe("#install");
    expect(screen.getByRole("link", { name: "查看趋势榜" }).getAttribute("href")).toBe("#trending");
    expect(screen.getByText("Prompt Saver").getAttribute("href")).toBe("https://example.com/prompt-saver");
    expect(screen.getByText("保存可复用的提示词。")).not.toBeNull();
    expect(screen.getByText("#1")).not.toBeNull();
    expect(screen.getByText("+42 stars")).not.toBeNull();
    expect(screen.getByText("Captured 2026-07-21 08:30 UTC")).not.toBeNull();
    expect(screen.getByRole("link", { name: "打开控制台" }).getAttribute("href")).toBe("/console");
    expect(screen.getByText("发现项目：从趋势信号中找到适合当前任务的项目。")).not.toBeNull();
    expect(screen.getByText("分析指定仓库：输入 owner/repo 获取当前项目观察。")).not.toBeNull();
    expect(screen.getByText("持续关注：持续跟踪已关注项目的变化。")).not.toBeNull();
  });
});

describe("TrendingBoard", () => {
  it("links every tab to an existing stable panel and hides inactive panels", () => {
    render(<TrendingBoard initialItems={[]} />);

    for (const tab of screen.getAllByRole("tab")) {
      const panel = document.getElementById(tab.getAttribute("aria-controls")!);
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
      expect(panel?.hidden).toBe(tab.getAttribute("aria-selected") !== "true");
    }
  });

  it("moves tab focus and loads the adjacent period with ArrowRight", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<TrendingBoard initialItems={[]} />);

    const today = screen.getByRole("tab", { name: "今日" });
    today.focus();
    fireEvent.keyDown(today, { key: "ArrowRight" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/trending?period=weekly"));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "本周", selected: true }));
    expect(screen.getByText("02")).not.toBeNull();
    expect(screen.getByText("Weekly stars")).not.toBeNull();
  });

  it("selects tabs with ArrowLeft, Home, and End", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<TrendingBoard initialItems={[]} />);

    const today = screen.getByRole("tab", { name: "今日" });
    fireEvent.keyDown(today, { key: "End" });
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/trending?period=monthly"));
    const monthly = screen.getByRole("tab", { name: "本月", selected: true });
    expect(document.activeElement).toBe(monthly);

    fireEvent.keyDown(monthly, { key: "Home" });
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/trending?period=daily"));
    const selectedToday = screen.getByRole("tab", { name: "今日", selected: true });
    fireEvent.keyDown(selectedToday, { key: "ArrowLeft" });
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/trending?period=monthly"));
    expect(screen.getByRole("tab", { name: "本月", selected: true })).toBe(document.activeElement);
  });

  it("does not move focus or selection when keyboard navigation is rejected while loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<TrendingBoard initialItems={[]} />);

    const today = screen.getByRole("tab", { name: "今日" });
    fireEvent.keyDown(today, { key: "ArrowRight" });
    const weekly = screen.getByRole("tab", { name: "本周", selected: true });
    fireEvent.keyDown(weekly, { key: "ArrowRight" });

    expect(document.activeElement).toBe(weekly);
    expect(screen.getByRole("tab", { name: "本周", selected: true })).toBe(weekly);
    expect(screen.getByRole("tab", { name: "本月" }).getAttribute("aria-selected")).toBe("false");
  });

  it("fetches and renders the selected period", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: "repo-scout", name: "Repo Scout", description: "筛选开源仓库。" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TrendingBoard initialItems={[]} />);
    fireEvent.click(screen.getByRole("tab", { name: "本周" }));

    expect(screen.getByText("正在加载趋势榜…")).not.toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/trending?period=weekly"));
    expect(await screen.findByText("Repo Scout")).not.toBeNull();
    expect(screen.getByText("筛选开源仓库。")).not.toBeNull();
  });

  it("states when the selected period has no results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }));
    render(<TrendingBoard initialItems={[]} />);

    fireEvent.click(screen.getByRole("tab", { name: "本月" }));

    expect(await screen.findByText("暂无本月趋势 Skill。")).not.toBeNull();
  });

  it("treats the API's unavailable trending response as an empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ kind: "not_found", reason: "trending_unavailable", period: "weekly" }),
    }));
    render(<TrendingBoard initialItems={[]} />);

    fireEvent.click(screen.getByRole("tab", { name: "本周" }));

    expect(await screen.findByText("暂无本周趋势 Skill。")).not.toBeNull();
    expect(screen.queryByText("趋势榜暂时无法加载，请稍后重试。")).toBeNull();
  });

  it("states when the selected period cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<TrendingBoard initialItems={[]} />);

    fireEvent.click(screen.getByRole("tab", { name: "本周" }));

    expect(await screen.findByText("趋势榜暂时无法加载，请稍后重试。")).not.toBeNull();
  });

  it("retries the selected period after an error", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [{ id: "retry-skill", name: "Retry Skill" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<TrendingBoard initialItems={[]} />);

    fireEvent.click(screen.getByRole("tab", { name: "本周" }));
    expect(await screen.findByText("趋势榜暂时无法加载，请稍后重试。")).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "本周" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Retry Skill")).not.toBeNull();
  });

  it("renders the factual repository fields returned by the trending API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          rank: 1,
          fullName: "acme/skill-finder",
          repoUrl: "https://github.com/acme/skill-finder",
          language: "TypeScript",
          starsInPeriod: 42,
          stars: 1_200,
          capturedAt: "2026-07-21T08:30:00.000Z",
        }],
      }),
    }));
    render(<TrendingBoard initialItems={[]} />);

    fireEvent.click(screen.getByRole("tab", { name: "本周" }));

    const repository = await screen.findByText("acme/skill-finder");
    expect(repository.getAttribute("href")).toBe("https://github.com/acme/skill-finder");
    expect(screen.getByText("#1")).not.toBeNull();
    expect(screen.getByText("TypeScript")).not.toBeNull();
    expect(screen.getByText("+42")).not.toBeNull();
    expect(screen.getByText("1,200")).not.toBeNull();
    expect(screen.getByText("2026-07-21 08:30 UTC")).not.toBeNull();
  });

  it("retains the last successful capture time when a later period is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ kind: "not_found", reason: "trending_unavailable", period: "weekly" }),
    }));
    render(<TrendingBoard initialItems={[{
      id: "initial",
      name: "Initial signal",
      rank: 1,
      capturedAt: "2026-07-21T08:30:00.000Z",
    }]} />);

    fireEvent.click(screen.getByRole("tab", { name: "本周" }));

    expect(await screen.findByText("暂无本周趋势 Skill。")).not.toBeNull();
    expect(screen.getByText("Last captured 2026-07-21 08:30 UTC")).not.toBeNull();
  });

  it("retries an initially unavailable daily board when today is selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: "recovered", name: "Recovered signal" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TrendingBoard initialItems={[]} initialUnavailable />);

    fireEvent.click(screen.getByRole("tab", { name: "今日" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/trending?period=daily"));
    expect(await screen.findByText("Recovered signal")).not.toBeNull();
  });
});
