import { describe, expect, it, vi } from "vitest";
import {
  ContentAnalysisError,
  ModelContentAnalyzer,
} from "../../../src/analysis/model-content-analyzer.js";

const input = [
  { id: "post-1", text: "Ace Hunter looks useful", authorUsername: "alice" },
  { id: "post-2", text: "Does it support alerts?", authorUsername: "bob" },
];

function analysis(postId: string, overrides: Record<string, unknown> = {}) {
  return {
    postId,
    relevanceScore: 0.8,
    topic: "product feedback",
    sentiment: "positive",
    stance: "support",
    automationProbability: 0.1,
    isProjectAffiliated: false,
    ...overrides,
  };
}

function modelResponse(analyses: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ analyses }) } }],
  }), { status, headers: { "content-type": "application/json" } });
}

function analyzer(fetcher: typeof fetch) {
  return new ModelContentAnalyzer({
    apiKey: "deepseek-secret",
    baseUrl: "https://api.deepseek.example/v1/",
    model: "deepseek-chat",
    fetcher,
  });
}

describe("ModelContentAnalyzer", () => {
  it("rejects a remote plaintext endpoint before exposing the API key", () => {
    expect(() => new ModelContentAnalyzer({ apiKey: "secret", baseUrl: "http://deepseek.example/v1",
      model: "deepseek-chat" })).toThrow(/invalid_analysis_input/);
  });

  it("uses native fetch JSON Output with an explicit schema and returns one versioned result for every requested ID", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => modelResponse([
      analysis("post-2", { sentiment: "neutral", stance: "question" }),
      analysis("post-1"),
    ]));

    const result = await analyzer(fetcher).analyze(input);

    expect(result.map((item) => item.postId)).toEqual(["post-1", "post-2"]);
    expect(result.every((item) => item.analysisVersion === "x-v1")).toBe(true);
    expect(result.every((item) => item.modelName === "deepseek-chat")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.deepseek.example/v1/chat/completions");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer deepseek-secret",
        "Content-Type": "application/json",
      },
    });
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      response_format: {
        type: string;
      };
      messages: Array<{ content: string }>;
    };
    expect(body.model).toBe("deepseek-chat");
    expect(body.response_format).toMatchObject({
      type: "json_object",
    });
    expect(body.messages[0].content).toContain('"required":["analyses"]');
    expect(body.messages[1].content).toContain("post-1");
  });

  it.each([
    ["missing", [analysis("post-1")]],
    ["extra", [analysis("post-1"), analysis("post-2"), analysis("post-3")]],
    ["duplicate", [analysis("post-1"), analysis("post-1")]],
    ["out-of-range relevance", [analysis("post-1", { relevanceScore: 1.01 }), analysis("post-2")]],
    ["out-of-range automation", [analysis("post-1"), analysis("post-2", { automationProbability: -0.01 })]],
  ])("retries malformed %s output twice before accepting a strict response", async (_name, malformed) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(modelResponse(malformed))
      .mockResolvedValueOnce(modelResponse(malformed))
      .mockResolvedValueOnce(modelResponse([analysis("post-1"), analysis("post-2")]));

    await expect(analyzer(fetcher).analyze(input)).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("returns a typed sanitized partial failure after the malformed retry budget", async () => {
    const responseSecret = "provider-body-secret";
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        analyses: [analysis("post-1"), analysis("post-2", { topic: "" }), responseSecret],
      }) } }],
    })));

    const caught = await analyzer(fetcher).analyze(input).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ContentAnalysisError);
    expect(caught).toMatchObject({
      code: "malformed_model_output",
      failedPostIds: ["post-2"],
      partialResults: [expect.objectContaining({ postId: "post-1" })],
    });
    expect((caught as Error).message).toBe("Content analysis failed: malformed_model_output");
    expect(JSON.stringify(caught)).not.toContain(responseSecret);
    expect(JSON.stringify(caught)).not.toContain("deepseek-secret");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not retry transport failures and sanitizes provider responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("provider-secret", { status: 503 }));

    const caught = await analyzer(fetcher).analyze(input).catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: "model_unavailable", failedPostIds: ["post-1", "post-2"] });
    expect((caught as Error).message).not.toMatch(/provider-secret|deepseek-secret/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("honors an observation-level abort before the model timeout", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const service = new ModelContentAnalyzer({
      apiKey: "deepseek-secret",
      baseUrl: "https://api.deepseek.example/v1",
      model: "deepseek-chat",
      fetcher,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const pending = service.analyze(input);
    controller.abort(new Error("observation_deadline"));
    await expect(pending).rejects.toMatchObject({ code: "model_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate input IDs without sending content and avoids a request for empty input", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = analyzer(fetcher);

    await expect(service.analyze([input[0], { ...input[1], id: "post-1" }]))
      .rejects.toMatchObject({ code: "invalid_analysis_input" });
    await expect(service.analyze([])).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
