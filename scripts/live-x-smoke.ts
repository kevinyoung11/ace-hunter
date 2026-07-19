import { ModelContentAnalyzer } from "../src/analysis/model-content-analyzer.js";
import { loadRuntimeConfig } from "../src/config/load-config.js";
import { resolveExecutablePath } from "../src/cli/runtime-dependencies.js";
import { TwitterCliSource } from "../src/sources/x/twitter-cli-source.js";
import { XSourceError } from "../src/sources/x/x-source.js";
import { createHttpTransport } from "../src/core/http-transport.js";

const config = loadRuntimeConfig(process.env);
if (!config.deepseekApiKey) throw new Error("deepseek_configuration_required");
const source = new TwitterCliSource({
  cliPath: resolveExecutablePath(config.twitterCliPath, process.env.PATH),
});
const http = createHttpTransport(process.env);

try {
await retrySource(() => source.assertAuthenticated());
const now = new Date();
const posts = await retrySource(() => source.searchPosts({
  query: process.env.E2E_X_REPO_QUERY ?? '"https://github.com/xai-org/grok-build"',
  since: new Date(now.getTime() - 7 * 86_400_000),
  until: now,
  limit: 5,
}));
if (posts.length === 0) throw new Error("fixture_unavailable:search_empty");

const rootId = publicTweetId("E2E_X_ROOT_TWEET_ID", "2078468415967367298");
const replies = await retrySource(() => source.searchReplies(rootId, new Date(now.getTime() - 30 * 86_400_000), 20));
if (replies.length === 0 || !replies.every((post) => post.rootPostId === rootId)) {
  throw new Error("fixture_unavailable:replies_empty");
}

const articleId = publicTweetId("E2E_X_ARTICLE_TWEET_ID", "2078268943345803407");
const article = await retrySource(() => source.getArticle(articleId));
if (article.articleText.trim().length === 0) throw new Error("fixture_unavailable:article_empty");

const analyzedPost = posts[0];
const analyzer = new ModelContentAnalyzer({
  apiKey: config.deepseekApiKey,
  baseUrl: config.deepseekBaseUrl,
  model: config.deepseekModel,
  fetcher: http.fetcher,
});
const analyses = await analyzer.analyze([{
  id: analyzedPost.id,
  text: analyzedPost.content,
  authorUsername: analyzedPost.authorUsername,
}]);
const analysis = analyses[0];
if (!analysis || analysis.postId !== analyzedPost.id || analysis.modelName !== config.deepseekModel ||
    !analysis.analysisVersion || !Number.isFinite(analysis.relevanceScore)) {
  throw new Error("deepseek_classification_invalid");
}

process.stdout.write(`${JSON.stringify({
  searchCount: posts.length,
  searchPostId: analyzedPost.id,
  replyCount: replies.length,
  rootPostId: rootId,
  articlePostId: articleId,
})}\n`);
} finally {
  await http.close();
}

function publicTweetId(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  if (!/^\d{1,32}$/.test(value)) throw new Error(`${name}_invalid`);
  return value;
}

async function retrySource<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof XSourceError) || !new Set(["timeout", "source_unavailable"]).has(error.code) || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
    }
  }
}
