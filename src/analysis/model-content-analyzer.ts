import { z } from "zod";
import {
  X_ANALYSIS_VERSION,
  type ContentAnalyzer,
  type ContentAnalysisInput,
  type PostAnalysis,
} from "./content-analyzer.js";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ContentAnalysisErrorCode =
  | "invalid_analysis_input"
  | "malformed_model_output"
  | "model_unavailable";

export class ContentAnalysisError extends Error {
  public readonly name = "ContentAnalysisError";

  public constructor(
    public readonly code: ContentAnalysisErrorCode,
    public readonly failedPostIds: readonly string[],
    public readonly partialResults: readonly PostAnalysis[] = [],
  ) {
    super(`Content analysis failed: ${code}`);
  }
}

export interface ModelContentAnalyzerOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

const inputSchema = z.object({
  id: z.string().trim().min(1).max(512),
  text: z.string().min(1).max(100_000),
  authorUsername: z.string().trim().min(1).max(512),
}).strict();

const rawAnalysisSchema = z.object({
  postId: z.string().min(1).max(512),
  relevanceScore: z.number().min(0).max(1),
  topic: z.string().trim().min(1).max(1_000),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  stance: z.enum(["support", "question", "challenge", "bug", "neutral", "spam"]),
  automationProbability: z.number().min(0).max(1),
  isProjectAffiliated: z.boolean(),
}).strict();

const providerEnvelopeSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().min(1) }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();

type RawAnalysis = z.infer<typeof rawAnalysisSchema>;

const responseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["analyses"],
  properties: {
    analyses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "postId", "relevanceScore", "topic", "sentiment", "stance",
          "automationProbability", "isProjectAffiliated",
        ],
        properties: {
          postId: { type: "string" },
          relevanceScore: { type: "number", minimum: 0, maximum: 1 },
          topic: { type: "string", minLength: 1 },
          sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
          stance: {
            type: "string",
            enum: ["support", "question", "challenge", "bug", "neutral", "spam"],
          },
          automationProbability: { type: "number", minimum: 0, maximum: 1 },
          isProjectAffiliated: { type: "boolean" },
        },
      },
    },
  },
} as const;

class MalformedOutput extends Error {
  public constructor(
    public readonly failedPostIds: readonly string[],
    public readonly partialResults: readonly PostAnalysis[],
  ) {
    super("malformed_model_output");
  }
}

export class ModelContentAnalyzer implements ContentAnalyzer {
  private readonly fetcher: Fetcher;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  public constructor(private readonly options: ModelContentAnalyzerOptions) {
    if (!isSafeCredential(options.apiKey) || !isSafeName(options.model)) {
      throw new ContentAnalysisError("invalid_analysis_input", []);
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch {
      throw new ContentAnalysisError("invalid_analysis_input", []);
    }
    if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) {
      throw new ContentAnalysisError("invalid_analysis_input", []);
    }
    this.endpoint = `${baseUrl.toString().replace(/\/+$/u, "")}/chat/completions`;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 ||
        !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new ContentAnalysisError("invalid_analysis_input", []);
    }
  }

  public async analyze(posts: ReadonlyArray<ContentAnalysisInput>): Promise<PostAnalysis[]> {
    const parsedInputs = z.array(inputSchema).max(100).safeParse(posts);
    const ids = posts.map((post) => typeof post.id === "string" ? post.id : "");
    if (!parsedInputs.success || new Set(ids).size !== ids.length) {
      throw new ContentAnalysisError("invalid_analysis_input", uniqueNonempty(ids));
    }
    if (parsedInputs.data.length === 0) return [];

    let lastMalformed = new MalformedOutput(ids, []);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.options.signal?.aborted) {
        throw new ContentAnalysisError("model_unavailable", ids);
      }
      try {
        return await this.requestAnalysis(parsedInputs.data);
      } catch (error) {
        if (!(error instanceof MalformedOutput)) throw error;
        lastMalformed = error;
      }
    }
    throw new ContentAnalysisError(
      "malformed_model_output",
      lastMalformed.failedPostIds,
      lastMalformed.partialResults,
    );
  }

  private async requestAnalysis(posts: ReadonlyArray<ContentAnalysisInput>): Promise<PostAnalysis[]> {
    const controller = new AbortController();
    const signal = this.options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, this.options.signal]);
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: `Classify every X post. Return JSON matching this schema exactly and include one analysis for each supplied ID and no others: ${JSON.stringify(responseJsonSchema)}`,
            },
            { role: "user", content: JSON.stringify({ posts }) },
          ],
          response_format: {
            type: "json_object",
          },
          max_tokens: 4_096,
        }),
        signal,
      });
    } catch {
      throw new ContentAnalysisError("model_unavailable", posts.map(({ id }) => id));
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ContentAnalysisError("model_unavailable", posts.map(({ id }) => id));
    }

    let text: string;
    try {
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("response_too_large");
      }
      text = await response.text();
      if (Buffer.byteLength(text, "utf8") > this.maxResponseBytes) throw new Error("response_too_large");
    } catch {
      throw new ContentAnalysisError("model_unavailable", posts.map(({ id }) => id));
    }

    let rawItems: unknown[];
    try {
      const provider = providerEnvelopeSchema.parse(JSON.parse(text));
      const modelJson: unknown = JSON.parse(provider.choices[0].message.content);
      const record = z.object({ analyses: z.array(z.unknown()).max(100) }).strict().parse(modelJson);
      rawItems = record.analyses;
    } catch {
      throw new MalformedOutput(posts.map(({ id }) => id), []);
    }
    return validateCompleteOutput(rawItems, posts, this.options.model);
  }
}

function validateCompleteOutput(
  rawItems: readonly unknown[],
  posts: ReadonlyArray<ContentAnalysisInput>,
  modelName: string,
): PostAnalysis[] {
  const requestedIds = new Set(posts.map(({ id }) => id));
  const validById = new Map<string, PostAnalysis>();
  let hasUnknownOrDuplicate = false;
  for (const item of rawItems) {
    const parsed = rawAnalysisSchema.safeParse(item);
    if (!parsed.success || !requestedIds.has(parsed.data.postId) || validById.has(parsed.data.postId)) {
      hasUnknownOrDuplicate = true;
      continue;
    }
    validById.set(parsed.data.postId, versioned(parsed.data, modelName));
  }
  const failedPostIds = posts.filter(({ id }) => !validById.has(id)).map(({ id }) => id);
  const partialResults = posts.flatMap(({ id }) => {
    const result = validById.get(id);
    return result === undefined ? [] : [result];
  });
  if (hasUnknownOrDuplicate || failedPostIds.length > 0 || rawItems.length !== posts.length) {
    throw new MalformedOutput(failedPostIds, partialResults);
  }
  return partialResults;
}

function versioned(raw: RawAnalysis, modelName: string): PostAnalysis {
  return { ...raw, analysisVersion: X_ANALYSIS_VERSION, modelName };
}

function isSafeCredential(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    value === value.trim() && !hasControlCharacter(value);
}

function isSafeName(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value === value.trim() && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function uniqueNonempty(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
