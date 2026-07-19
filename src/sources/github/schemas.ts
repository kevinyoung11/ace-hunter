import { z } from "zod";
import type { GitHubRepository } from "./github-source.js";
import { safePublicHomepage, validateGitHubIdentityUrls } from "./url-validation.js";

const safeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bounded = (max: number) => z.string().min(1).max(max);
const absoluteHttpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
});

const ownerSchema = z.object({
  id: safeId,
  login: bounded(100),
  type: z.enum(["User", "Organization"]),
  html_url: absoluteHttpUrl,
  avatar_url: absoluteHttpUrl,
}).passthrough();

export const githubRepositorySchema = z.object({
  id: safeId,
  node_id: bounded(256),
  name: bounded(255),
  full_name: bounded(512).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  private: z.boolean(),
  owner: ownerSchema,
  html_url: absoluteHttpUrl,
  description: z.string().max(10_000).nullable(),
  fork: z.boolean(),
  created_at: z.string().datetime({ offset: true }),
  pushed_at: z.string().datetime({ offset: true }).nullable(),
  homepage: z.string().max(2_048).nullable(),
  stargazers_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  forks_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  archived: z.boolean(),
  disabled: z.boolean(),
  visibility: z.enum(["public", "private", "internal"]),
  mirror_url: z.string().max(2_048).nullable(),
  is_template: z.boolean().default(false),
  default_branch: bounded(255),
  language: z.string().max(100).nullable(),
  license: z.object({ spdx_id: z.string().max(100).nullable() }).passthrough().nullable(),
  topics: z.array(z.string().min(1).max(100)).max(100),
}).passthrough();

export const githubSearchResponseSchema = z.object({
  total_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  incomplete_results: z.boolean(),
  items: z.array(githubRepositorySchema).max(100),
}).passthrough();

export const githubRateLimitSchema = z.object({
  resources: z.object({
    search: z.object({
      remaining: z.number().int().nonnegative(),
      reset: z.number().int().nonnegative(),
    }).passthrough(),
    core: z.object({ remaining: z.number().int().nonnegative(), reset: z.number().int().nonnegative() }).passthrough().optional(),
    graphql: z.object({ remaining: z.number().int().nonnegative(), reset: z.number().int().nonnegative() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

export function mapGitHubRepository(value: z.infer<typeof githubRepositorySchema>): GitHubRepository {
  if (value.private || value.visibility !== "public") throw new Error("private_repository");
  if (value.disabled) throw new Error("repository_inaccessible");
  const urls = validateGitHubIdentityUrls({ fullName: value.full_name, ownerLogin: value.owner.login,
    repoUrl: value.html_url, ownerUrl: value.owner.html_url, avatarUrl: value.owner.avatar_url });
  return {
    githubRepoId: value.id,
    nodeId: value.node_id,
    ownerId: value.owner.id,
    ownerLogin: value.owner.login,
    ownerType: value.owner.type,
    ownerProfileUrl: urls.ownerUrl,
    ownerAvatarUrl: urls.avatarUrl,
    name: value.name,
    fullName: value.full_name,
    description: value.description,
    repoUrl: urls.repoUrl,
    homepageUrl: safePublicHomepage(value.homepage),
    defaultBranch: value.default_branch,
    language: value.language,
    license: value.license?.spdx_id ?? null,
    topics: [...new Set(value.topics)],
    hasReadme: false,
    createdAt: new Date(value.created_at),
    pushedAt: value.pushed_at === null ? null : new Date(value.pushed_at),
    stars: value.stargazers_count,
    forks: value.forks_count,
    visibility: "public",
    isPrivate: false,
    isFork: value.fork,
    isArchived: value.archived,
    isTemplate: value.is_template,
    isMirror: value.mirror_url !== null,
  };
}
