import { isAbsolute } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  twitterArticleSchema,
  twitterEnvelopeSchema,
  twitterStatusSchema,
  twitterTweetListSchema,
} from "./schemas.js";
import { XSourceError, type XPostFact, type XSearchInput, type XSourceAdapter } from "./x-source.js";

export type TwitterCommand = "status" | "search" | "tweet" | "article";
export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface TwitterCliSourceOptions {
  cliPath: string;
  spawnProcess?: SpawnProcess;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const exactVersion = "0.8.5";
const maxSearchResults = 50;
const maxReplyResults = 20;
const numericId = /^\d+$/;

function fail(code: string): never {
  throw new XSourceError(code);
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime()) && value.getUTCFullYear() >= 1970 && value.getUTCFullYear() <= 2099;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return fail("twitter_response_invalid");
  }
}

export async function assertTwitterCliVersion(runVersion: () => Promise<string>): Promise<void> {
  let stdout: string;
  try {
    stdout = await runVersion();
  } catch (error) {
    if (error instanceof XSourceError) throw error;
    return fail("source_unavailable");
  }
  const match = stdout.match(/(?:twitter(?:-cli)?)(?:,)?\s+version\s+(\d+\.\d+\.\d+)/i)
    ?? stdout.match(/twitter-cli\s+(\d+\.\d+\.\d+)/i);
  if (match?.[1] !== exactVersion) fail("twitter_cli_version");
}

export async function parseTwitterEnvelope(input: unknown, command: TwitterCommand): Promise<unknown> {
  const envelope = twitterEnvelopeSchema.safeParse(input);
  if (!envelope.success) fail("twitter_response_invalid");
  if (envelope.data.schema_version !== "1") fail("twitter_schema_version");
  if (!envelope.data.ok) {
    fail(command === "status" ? "twitter_auth_required" : "source_unavailable");
  }

  if (command === "status") {
    const status = twitterStatusSchema.safeParse(envelope.data.data);
    if (!status.success) {
      const unauthenticated = typeof envelope.data.data === "object"
        && envelope.data.data !== null
        && "authenticated" in envelope.data.data
        && envelope.data.data.authenticated === false;
      fail(unauthenticated ? "twitter_auth_required" : "twitter_response_invalid");
    }
    return status.data;
  }
  if (command === "search" || command === "tweet") {
    const tweets = twitterTweetListSchema.safeParse(envelope.data.data);
    if (!tweets.success) fail("twitter_response_invalid");
    return tweets.data;
  }
  const article = twitterArticleSchema.safeParse(envelope.data.data);
  if (!article.success || article.data.articleText.trim() === "") fail("twitter_response_invalid");
  return article.data;
}

export class TwitterCliSource implements XSourceAdapter {
  private readonly cliPath: string;
  private readonly spawnProcess: SpawnProcess;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  public constructor(options: TwitterCliSourceOptions) {
    if (!isAbsolute(options.cliPath)) fail("twitter_cli_path");
    this.cliPath = options.cliPath;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) fail("x_validation_error");
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) fail("x_validation_error");
  }

  public capabilities(): { recentSearchDays: number; replies: boolean } {
    return { recentSearchDays: 7, replies: true };
  }

  public async assertAuthenticated(): Promise<void> {
    await assertTwitterCliVersion(async () => await this.execute(["--version"]));
    await parseTwitterEnvelope(parseJson(await this.execute(["status", "--json"])), "status");
  }

  public async searchPosts(input: XSearchInput): Promise<XPostFact[]> {
    if (
      input.query.trim() === ""
      || input.query.length > 512
      || hasControlCharacters(input.query)
      || !validDate(input.since)
      || !validDate(input.until)
      || input.since.getTime() >= input.until.getTime()
      || !Number.isInteger(input.limit)
      || input.limit < 1
      || input.limit > maxSearchResults
    ) fail("x_validation_error");

    const output = await this.execute([
      "search",
      input.query,
      "--type",
      "latest",
      "--since",
      utcDay(input.since),
      "--until",
      // X's `until:` date is exclusive. Advancing one UTC day prevents the
      // date-only CLI filter from dropping posts created earlier today.
      utcDay(new Date(input.until.getTime() + 86_400_000)),
      "--exclude",
      "retweets",
      "--max",
      String(input.limit),
      "--json",
    ]);
    const parsed = await parseTwitterEnvelope(parseJson(output), "search");
    const tweets = twitterTweetListSchema.parse(parsed);
    return tweets.filter((tweet) => !tweet.isRetweet).map((tweet) => this.toFact(tweet, tweet.id, null))
      .filter((tweet) => tweet.createdAt.getTime() >= input.since.getTime() && tweet.createdAt.getTime() <= input.until.getTime())
      .slice(0, input.limit);
  }

  public async searchReplies(conversationId: string, since: Date, limit: number): Promise<XPostFact[]> {
    if (
      !numericId.test(conversationId)
      || !validDate(since)
      || !Number.isInteger(limit)
      || limit < 1
      || limit > maxReplyResults
    ) fail("x_validation_error");
    const output = await this.execute(["tweet", conversationId, "--max", String(limit + 1), "--json"]);
    const parsed = await parseTwitterEnvelope(parseJson(output), "tweet");
    const tweets = twitterTweetListSchema.parse(parsed);
    if (!tweets.some((tweet) => tweet.id === conversationId)) fail("twitter_response_invalid");
    return tweets
      .filter((tweet) => tweet.id !== conversationId && !tweet.isRetweet)
      .map((tweet) => this.toFact(tweet, conversationId, conversationId))
      .filter((tweet) => tweet.createdAt.getTime() >= since.getTime())
      .slice(0, limit);
  }

  public async getArticle(tweetId: string): Promise<{ articleText: string }> {
    if (!numericId.test(tweetId)) fail("x_validation_error");
    const parsed = await parseTwitterEnvelope(parseJson(await this.execute(["article", tweetId, "--json"])), "article");
    const article = twitterArticleSchema.parse(parsed);
    return { articleText: article.articleText.trim() };
  }

  private toFact(
    tweet: ReturnType<typeof twitterTweetListSchema.parse>[number],
    rootPostId: string,
    inReplyToPostId: string | null,
  ): XPostFact {
    const createdAt = new Date(tweet.createdAtISO ?? tweet.createdAt ?? "");
    if (!validDate(createdAt)) fail("twitter_response_invalid");
    const articleText = tweet.articleText?.trim();
    return {
      id: tweet.id,
      conversationId: rootPostId,
      rootPostId,
      inReplyToPostId,
      authorId: tweet.author.id,
      authorUsername: tweet.author.screenName,
      authorName: tweet.author.name,
      authorVerified: tweet.author.verified,
      content: articleText || tweet.text,
      language: tweet.lang ?? null,
      url: `https://x.com/${tweet.author.screenName}/status/${tweet.id}`,
      createdAt,
      likes: tweet.metrics.likes,
      reposts: tweet.metrics.retweets,
      quotes: tweet.metrics.quotes,
      replies: tweet.metrics.replies,
      bookmarks: tweet.metrics.bookmarks,
      views: tweet.metrics.views,
      isArticle: articleText !== undefined && articleText.length > 0 || tweet.articleTitle !== undefined,
    };
  }

  private async execute(args: readonly string[]): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      let stdout = "";
      const stdoutDecoder = new StringDecoder("utf8");
      let outputBytes = 0;
      let settled = false;
      const child = this.spawnProcess(this.cliPath, args, {
        shell: false,
        stdio: "pipe",
        windowsHide: true,
        // Local browser/session state is sufficient; database, GitHub, and
        // model credentials must not be inherited by the child process.
        env: twitterEnvironment(process.env),
      });

      const finish = (error: XSourceError | null, value = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === null) resolve(value);
        else reject(error);
      };
      const count = (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > this.maxOutputBytes) {
          child.kill("SIGTERM");
          finish(new XSourceError("twitter_output_too_large"));
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        count(chunk);
        if (!settled) stdout += stdoutDecoder.write(chunk);
      });
      child.stderr.on("data", count);
      child.once("error", () => finish(new XSourceError("source_unavailable")));
      child.once("close", (code, signal) => {
        if (code !== 0 || signal !== null) finish(new XSourceError("source_unavailable"));
        else finish(null, stdout + stdoutDecoder.end());
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new XSourceError("timeout"));
      }, this.timeoutMs);
    });
  }
}

function twitterEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "PATH",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;
  return Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])) as NodeJS.ProcessEnv;
}
