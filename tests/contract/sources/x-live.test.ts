import { describe, expect, it } from "vitest";
import { TwitterCliSource } from "../../../src/sources/x/twitter-cli-source.js";

const live = process.env.RUN_LIVE_X_CONTRACT === "1" ? describe : describe.skip;

live("live twitter-cli contract", () => {
  it("checks auth and the three replaceable public fixtures", async () => {
    const source = new TwitterCliSource({ cliPath: process.env.TWITTER_CLI_PATH ?? "/Users/apulu/.local/bin/twitter" });
    await source.assertAuthenticated();
    const posts = await source.searchPosts({
      query: process.env.E2E_X_REPO_QUERY ?? '"https://github.com/xai-org/grok-build"',
      since: new Date(Date.now() - 7 * 86_400_000),
      until: new Date(),
      limit: 5,
    });
    if (posts.length === 0) throw new Error("fixture_unavailable");

    const rootId = process.env.E2E_X_ROOT_TWEET_ID ?? "2078468415967367298";
    const replies = await source.searchReplies(rootId, new Date(Date.now() - 30 * 86_400_000), 5);
    expect(replies.length).toBeGreaterThan(0);

    const articleId = process.env.E2E_X_ARTICLE_TWEET_ID ?? "2078268943345803407";
    await expect(source.getArticle(articleId)).resolves.toEqual({ articleText: expect.any(String) });
  }, 60_000);
});
