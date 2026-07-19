import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  TwitterCliSource,
  assertTwitterCliVersion,
  parseTwitterEnvelope,
  type SpawnProcess,
} from "../../../src/sources/x/twitter-cli-source.js";

type Reply = { stdout?: string; stdoutChunks?: Buffer[]; stderr?: string; code?: number | null; signal?: NodeJS.Signals | null; neverClose?: boolean };

function fakeSpawn(replies: Reply[]) {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptionsWithoutStdio }> = [];
  const spawnProcess: SpawnProcess = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, {
      stdout,
      stderr,
      stdin: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const reply = replies.shift() ?? {};
    queueMicrotask(() => {
      for (const chunk of reply.stdoutChunks ?? []) stdout.write(chunk);
      stdout.end(reply.stdout ?? "");
      stderr.end(reply.stderr ?? "");
      if (!reply.neverClose) child.emit("close", reply.code ?? 0, reply.signal ?? null);
    });
    return child;
  };
  return { calls, spawnProcess };
}

const author = { id: "42", name: "Ada", screenName: "ada_dev", verified: true };
const metrics = { likes: 2, retweets: 3, replies: 4, quotes: 5, views: 6, bookmarks: 7 };
const tweet = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  text: `post ${id}`,
  author,
  metrics,
  createdAtISO: "2026-07-18T12:00:00.000Z",
  lang: "en",
  isRetweet: false,
  ...overrides,
});
const envelope = (data: unknown) => JSON.stringify({ ok: true, schema_version: "1", data });

describe("twitter-cli envelope", () => {
  it("requires exactly twitter-cli 0.8.5", async () => {
    await expect(assertTwitterCliVersion(async () => "twitter-cli, version 0.8.4\n")).rejects.toMatchObject({ code: "twitter_cli_version" });
    await expect(assertTwitterCliVersion(async () => "twitter-cli 0.9.0\n")).rejects.toMatchObject({ code: "twitter_cli_version" });
    await expect(assertTwitterCliVersion(async () => "twitter, version 0.8.5\n")).resolves.toBeUndefined();
  });

  it("validates command-specific authentication, schema version, and legal empty search", async () => {
    await expect(parseTwitterEnvelope({ ok: false, schema_version: "1", data: {} }, "status")).rejects.toMatchObject({ code: "twitter_auth_required" });
    await expect(parseTwitterEnvelope({ ok: true, schema_version: "1", data: { authenticated: false } }, "status")).rejects.toMatchObject({ code: "twitter_auth_required" });
    await expect(parseTwitterEnvelope({ ok: true, schema_version: "0", data: [] }, "search")).rejects.toMatchObject({ code: "twitter_schema_version" });
    await expect(parseTwitterEnvelope({ ok: true, schema_version: "1", data: [] }, "search")).resolves.toEqual([]);
  });
});

describe("TwitterCliSource", () => {
  it("rejects a relative executable before spawning", () => {
    expect(() => new TwitterCliSource({ cliPath: "twitter" })).toThrow(/twitter_cli_path/);
  });

  it("spawns only the configured absolute binary with shell disabled and authenticates in order", async () => {
    const fake = fakeSpawn([
      { stdout: "twitter, version 0.8.5\n" },
      { stdout: envelope({ authenticated: true, user: {} }) },
    ]);
    const source = new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: fake.spawnProcess });
    await source.assertAuthenticated();
    expect(fake.calls.map(({ command, args }) => [command, args])).toEqual([
      ["/opt/bin/twitter", ["--version"]],
      ["/opt/bin/twitter", ["status", "--json"]],
    ]);
    expect(fake.calls.every(({ options }) => options.shell === false)).toBe(true);
    expect(fake.calls.every(({ options }) => !Object.keys(options.env ?? {}).some((key) =>
      /(?:TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|AUTHORIZATION)/iu.test(key)))).toBe(true);
  });

  it("builds a bounded latest search and maps facts to canonical X URLs", async () => {
    const fake = fakeSpawn([{ stdout: envelope([tweet("123")]) }]);
    const source = new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: fake.spawnProcess });
    await expect(source.searchPosts({
      query: '"o/r"',
      since: new Date("2026-07-11T01:00:00.000Z"),
      until: new Date("2026-07-19T01:00:00.000Z"),
      limit: 50,
    })).resolves.toEqual([expect.objectContaining({
      id: "123",
      conversationId: "123",
      rootPostId: "123",
      inReplyToPostId: null,
      authorUsername: "ada_dev",
      url: "https://x.com/ada_dev/status/123",
      likes: 2,
      reposts: 3,
      bookmarks: 7,
      views: 6,
    })]);
    expect(fake.calls[0]?.args).toEqual([
      "search", '"o/r"', "--type", "latest", "--since", "2026-07-11", "--until", "2026-07-20",
      "--exclude", "retweets", "--max", "50", "--json",
    ]);
  });

  it("marks an Article shell from its title so the collection job can expand it", async () => {
    const fake = fakeSpawn([{ stdout: envelope([tweet("123", {
      text: "Article shell", articleTitle: "Analysis",
    })]) }]);
    const source = new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: fake.spawnProcess });
    await expect(source.searchPosts({ query: "article", since: new Date("2026-07-18"),
      until: new Date("2026-07-19"), limit: 1 })).resolves.toEqual([
      expect.objectContaining({ id: "123", content: "Article shell", isArticle: true }),
    ]);
  });

  it("applies the exact in-memory time window after using coarse CLI date filters", async () => {
    const fake = fakeSpawn([{ stdout: envelope([
      tweet("100", { createdAtISO: "2026-07-18T11:59:59.999Z" }),
      tweet("101", { createdAtISO: "2026-07-18T12:00:00.000Z" }),
      tweet("102", { createdAtISO: "2026-07-19T12:00:00.001Z" }),
    ]) }]);
    const source = new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: fake.spawnProcess });
    await expect(source.searchPosts({ query: "window", since: new Date("2026-07-18T12:00:00Z"),
      until: new Date("2026-07-19T12:00:00Z"), limit: 3 })).resolves.toEqual([
      expect.objectContaining({ id: "101" }),
    ]);
  });

  it("decodes JSON correctly when a multibyte character crosses stdout chunks", async () => {
    const body = Buffer.from(envelope([tweet("123", { text: "中文🙂" })]));
    const emoji = body.indexOf(Buffer.from("🙂"));
    const fake = fakeSpawn([{ stdoutChunks: [body.subarray(0, emoji + 1), body.subarray(emoji + 1)] }]);
    const source = new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: fake.spawnProcess });
    await expect(source.searchPosts({ query: "unicode", since: new Date("2026-07-18"),
      until: new Date("2026-07-19"), limit: 1 })).resolves.toEqual([
      expect.objectContaining({ content: "中文🙂" }),
    ]);
  });

  it("requires the requested root and returns only bounded replies", async () => {
    const fake = fakeSpawn([{ stdout: envelope([tweet("100"), tweet("101"), tweet("102")]) }]);
    const source = new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: fake.spawnProcess });
    await expect(source.searchReplies("100", new Date("2026-07-01T00:00:00Z"), 2)).resolves.toEqual([
      expect.objectContaining({ id: "101", conversationId: "100", rootPostId: "100", inReplyToPostId: "100" }),
      expect.objectContaining({ id: "102", conversationId: "100", rootPostId: "100", inReplyToPostId: "100" }),
    ]);
    expect(fake.calls[0]?.args).toEqual(["tweet", "100", "--max", "3", "--json"]);

    const missing = fakeSpawn([{ stdout: envelope([tweet("999")]) }]);
    await expect(new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: missing.spawnProcess })
      .searchReplies("100", new Date("2026-07-01T00:00:00Z"), 2)).rejects.toMatchObject({ code: "twitter_response_invalid" });
  });

  it("requires nonempty Article text", async () => {
    const success = fakeSpawn([{ stdout: envelope({ ...tweet("123"), articleText: "  useful article  " }) }]);
    await expect(new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: success.spawnProcess }).getArticle("123"))
      .resolves.toEqual({ articleText: "useful article" });
    expect(success.calls[0]?.args).toEqual(["article", "123", "--json"]);

    const empty = fakeSpawn([{ stdout: envelope({ ...tweet("123"), articleText: " " }) }]);
    await expect(new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: empty.spawnProcess }).getArticle("123"))
      .rejects.toMatchObject({ code: "twitter_response_invalid" });
  });

  it("rejects invalid ranges and quantity limits without spawning", async () => {
    const fake = fakeSpawn([]);
    const source = new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: fake.spawnProcess });
    await expect(source.searchPosts({ query: "x", since: new Date("2026-07-20"), until: new Date("2026-07-19"), limit: 1 }))
      .rejects.toMatchObject({ code: "x_validation_error" });
    await expect(source.searchPosts({ query: "x", since: new Date("2026-07-18"), until: new Date("2026-07-19"), limit: 51 }))
      .rejects.toMatchObject({ code: "x_validation_error" });
    await expect(source.searchReplies("100", new Date("2026-07-18"), 21)).rejects.toMatchObject({ code: "x_validation_error" });
    await expect(source.getArticle("not-an-id")).rejects.toMatchObject({ code: "x_validation_error" });
    expect(fake.calls).toHaveLength(0);
  });

  it("fails closed on nonzero exits, timeouts, malformed JSON, and oversized output without leaking stderr", async () => {
    const nonzero = fakeSpawn([{ code: 1, stderr: "session-token=super-secret" }]);
    await expect(new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: nonzero.spawnProcess }).searchPosts({
      query: "x", since: new Date("2026-07-18"), until: new Date("2026-07-19"), limit: 1,
    })).rejects.toSatisfy((error: unknown) => error instanceof Error && error.message === "source_unavailable" && !error.message.includes("super-secret"));

    const malformed = fakeSpawn([{ stdout: "not-json" }]);
    await expect(new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: malformed.spawnProcess }).searchPosts({
      query: "x", since: new Date("2026-07-18"), until: new Date("2026-07-19"), limit: 1,
    })).rejects.toMatchObject({ code: "twitter_response_invalid" });

    const oversized = fakeSpawn([{ stdout: "x".repeat(101) }]);
    await expect(new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: oversized.spawnProcess, maxOutputBytes: 100 }).searchPosts({
      query: "x", since: new Date("2026-07-18"), until: new Date("2026-07-19"), limit: 1,
    })).rejects.toMatchObject({ code: "twitter_output_too_large" });

    const timedOut = fakeSpawn([{ neverClose: true }]);
    await expect(new TwitterCliSource({ cliPath: "/opt/bin/twitter", spawnProcess: timedOut.spawnProcess, timeoutMs: 5 }).searchPosts({
      query: "x", since: new Date("2026-07-18"), until: new Date("2026-07-19"), limit: 1,
    })).rejects.toMatchObject({ code: "timeout" });
    expect(timedOut.calls).toHaveLength(1);
  });
});
