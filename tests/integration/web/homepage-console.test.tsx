// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { trending } = vi.hoisted(() => ({ trending: vi.fn() }));

vi.mock("../../../lib/web/service", () => ({ webService: () => ({ trending }) }));

import Homepage from "../../../app/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("product and console routes", () => {
  it("renders the data-backed homepage dynamically", async () => {
    const route = await import("../../../app/page");

    expect(route.dynamic).toBe("force-dynamic");
  });

  it("renders the factual daily trend as the homepage signal", async () => {
    trending.mockResolvedValue({
      kind: "trending",
      period: "daily",
      items: [{
        rank: 1,
        fullName: "acme/skill-finder",
        repoUrl: "https://github.com/acme/skill-finder",
        language: "TypeScript",
        starsInPeriod: 42,
        stars: 1200,
        capturedAt: "2026-07-21T00:00:00.000Z",
      }],
    });

    render(await Homepage());

    expect(trending).toHaveBeenCalledWith("daily");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("找到值得安装的 Skill");
    expect(screen.getAllByRole("link", { name: "acme/skill-finder" }).map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/acme/skill-finder",
      "https://github.com/acme/skill-finder",
    ]);
    expect(screen.getByRole("link", { name: "打开控制台" }).getAttribute("href")).toBe("/console");
  });

  it("does not fabricate a homepage signal when today's trend is unavailable", async () => {
    trending.mockResolvedValue({ kind: "not_found", reason: "trending_unavailable", period: "daily" });

    render(await Homepage());

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("找到值得安装的 Skill");
    expect(screen.getByText("暂无今日趋势 Skill。")).not.toBeNull();
    expect(screen.getByRole("link", { name: "打开控制台" }).getAttribute("href")).toBe("/console");
  });

  it("keeps the report dashboard at /console with console navigation links", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const route = "../../../app/console/page";
    const ConsolePage = (await import(route).catch(() => undefined))?.default;

    expect(ConsolePage).toBeTypeOf("function");
    if (!ConsolePage) return;

    render(<ConsolePage />);

    expect(screen.getByText("正在读取最新日报…")).not.toBeNull();
    expect(screen.getByRole("link", { name: "ACE HUNTER" }).getAttribute("href")).toBe("/console");
    expect(screen.getByRole("link", { name: "今日报告" }).getAttribute("href")).toBe("/console");
    expect(screen.getByRole("link", { name: "项目分析" }).getAttribute("href")).toBe("/analyze");
    expect(screen.getByRole("link", { name: "我的关注" }).getAttribute("href")).toBe("/monitors");
  });
});
