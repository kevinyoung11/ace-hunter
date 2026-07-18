import type { PoolClient } from "pg";
import { z } from "zod";
import { ProductStore } from "../db/stores/product-store.js";
import { RepositoryStore } from "../db/stores/repository-store.js";
import type { GitHubRepository } from "../sources/github/github-source.js";

export interface CapacityReviewOptions {
  reviewedCapacityOverride?: boolean;
  capacityReviewId?: string;
}

export interface ProductFromRepoResult {
  productId: string;
  repositoryId: string;
  capacity: "ok" | "warning" | "reviewed";
  created: boolean;
}

const repositorySchema = z.object({
  githubRepoId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  nodeId: z.string().min(1).max(256),
  ownerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ownerLogin: z.string().min(1).max(100),
  ownerType: z.enum(["User", "Organization"]),
  ownerProfileUrl: z.string().url().max(2_048),
  ownerAvatarUrl: z.string().url().max(2_048),
  name: z.string().min(1).max(255),
  fullName: z.string().min(3).max(512).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  description: z.string().max(10_000).nullable(),
  repoUrl: z.string().url().max(2_048),
  homepageUrl: z.string().url().max(2_048).nullable(),
  defaultBranch: z.string().min(1).max(255),
  language: z.string().max(100).nullable(),
  license: z.string().max(100).nullable(),
  topics: z.array(z.string().min(1).max(100)).max(100),
  hasReadme: z.boolean(), createdAt: z.date(), pushedAt: z.date().nullable(),
  stars: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  forks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  visibility: z.literal("public"), isPrivate: z.literal(false), isFork: z.boolean(),
  isArchived: z.boolean(), isTemplate: z.boolean(), isMirror: z.boolean(),
}).strict();

export async function createProductFromRepo(
  client: PoolClient,
  input: GitHubRepository,
  options: CapacityReviewOptions = {},
): Promise<ProductFromRepoResult> {
  const parsed = repositorySchema.safeParse(input);
  if (!parsed.success || !validDate(parsed.data?.createdAt) || parsed.data?.pushedAt && !validDate(parsed.data.pushedAt)) {
    throw new Error("invalid_repository");
  }
  const repo = parsed.data;
  const homepageUrl = safePublicHomepage(repo.homepageUrl);
  if (options.reviewedCapacityOverride === true && !validReviewId(options.capacityReviewId)) {
    throw new Error("capacity_review_id_required");
  }

  // Global capacity first, then the repository id: every caller uses this fixed order.
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ["ace_hunter:repository_capacity"]);
  await client.query("select pg_advisory_xact_lock($1::bigint)", [repo.githubRepoId]);
  const existing = await client.query<{ id: string }>(
    "select id from ace_hunter.repositories where github_repo_id=$1",
    [repo.githubRepoId],
  );
  const countResult = await client.query<{ count: number }>(
    "select count(*)::int count from ace_hunter.repositories where status='active'",
  );
  const oldCount = countResult.rows[0]?.count;
  if (!Number.isInteger(oldCount) || oldCount < 0) throw new Error("capacity_count_invalid");
  const creating = existing.rowCount === 0;
  if (creating && oldCount >= 1_000) throw new Error("capacity_hard_limit");
  if (creating && oldCount >= 950 && options.reviewedCapacityOverride !== true) {
    throw new Error("capacity_review_required");
  }

  const repositoryId = await new RepositoryStore(client).upsert({
    githubRepoId: repo.githubRepoId, githubNodeId: repo.nodeId, ownerId: repo.ownerId,
    ownerLogin: repo.ownerLogin, ownerType: repo.ownerType, ownerProfileUrl: repo.ownerProfileUrl,
    ownerAvatarUrl: repo.ownerAvatarUrl, name: repo.name, fullName: repo.fullName,
    description: normalizeDescription(repo.description), repoUrl: repo.repoUrl, homepageUrl,
    defaultBranch: repo.defaultBranch, language: repo.language, license: repo.license,
    topics: [...new Set(repo.topics)], hasReadme: repo.hasReadme, githubCreatedAt: repo.createdAt,
    githubPushedAt: repo.pushedAt, isFork: repo.isFork, isArchived: repo.isArchived,
    isTemplate: repo.isTemplate, isMirror: repo.isMirror,
  });
  const linked = await client.query<{ product_id: string }>(
    "select product_id from ace_hunter.product_repositories where repository_id=$1 order by is_primary desc,created_at limit 1",
    [repositoryId],
  );
  const newCount = oldCount + (creating ? 1 : 0);
  const capacity = creating && options.reviewedCapacityOverride === true
    ? "reviewed" as const
    : newCount >= 800 ? "warning" as const : "ok" as const;
  if (linked.rows[0]) return { productId: linked.rows[0].product_id, repositoryId, capacity, created: false };

  const productStore = new ProductStore(client);
  const productId = await productStore.create({
    name: repo.name,
    description: normalizeDescription(repo.description),
    websiteUrl: homepageUrl,
    identifiers: {
      github_full_names: [repo.fullName],
      domains: homepageUrl ? [new URL(homepageUrl).hostname.toLowerCase()] : [],
    },
  });
  await productStore.linkRepository({
    productId, repositoryId, role: "primary", isPrimary: true,
    confidence: 1, linkSource: "github_discovery",
  });
  return { productId, repositoryId, capacity, created: true };
}

function validDate(value: Date): boolean { return Number.isFinite(value.getTime()); }
function validReviewId(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
}
function normalizeDescription(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
function safePublicHomepage(value: string | null): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return null;
  const private172 = /^172\.(\d+)\./.exec(host);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return null;
  return url.toString();
}
