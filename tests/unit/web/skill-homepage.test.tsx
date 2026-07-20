// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillHomepage } from "../../../components/home/skill-homepage";
import { TrendingBoard } from "../../../components/home/trending-board";

const dailyTopSignal = {
  id: "prompt-saver",
  name: "Prompt Saver",
  description: "保存可复用的提示词。",
  href: "https://example.com/prompt-saver",
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
    expect(screen.getByRole("link", { name: "打开控制台" }).getAttribute("href")).toBe("/console");
    expect(screen.getByText("发现：从趋势信号中找到适合当前任务的能力。")).not.toBeNull();
    expect(screen.getByText("安装：把选中的 Skill 接入自己的工作流。")).not.toBeNull();
    expect(screen.getByText("持续更新：跟踪能力变化，及时获得新的可用方案。")).not.toBeNull();
  });
});

describe("TrendingBoard", () => {
  it("fetches and renders the selected period", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: "repo-scout", name: "Repo Scout", description: "筛选开源仓库。" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TrendingBoard initialItems={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "本周" }));

    expect(screen.getByText("正在加载趋势榜…")).not.toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/trending?period=weekly"));
    expect(await screen.findByText("Repo Scout")).not.toBeNull();
    expect(screen.getByText("筛选开源仓库。")).not.toBeNull();
  });

  it("states when the selected period has no results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }));
    render(<TrendingBoard initialItems={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "本月" }));

    expect(await screen.findByText("暂无本月趋势 Skill。")).not.toBeNull();
  });

  it("states when the selected period cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<TrendingBoard initialItems={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "本周" }));

    expect(await screen.findByText("趋势榜暂时无法加载，请稍后重试。")).not.toBeNull();
  });

  it("renders the factual repository fields returned by the trending API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ rank: 1, fullName: "acme/skill-finder", repoUrl: "https://github.com/acme/skill-finder", language: "TypeScript" }],
      }),
    }));
    render(<TrendingBoard initialItems={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "本周" }));

    const repository = await screen.findByText("acme/skill-finder");
    expect(repository.getAttribute("href")).toBe("https://github.com/acme/skill-finder");
  });
});
