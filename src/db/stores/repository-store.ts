import type { Queryable } from "./queryable.js";

export interface RepositoryInput {
  githubRepoId: number;
  githubNodeId?: string | null;
  ownerId?: number | null;
  ownerLogin: string;
  ownerType?: string | null;
  ownerProfileUrl?: string | null;
  ownerAvatarUrl?: string | null;
  name: string;
  fullName: string;
  description?: string | null;
  repoUrl: string;
  homepageUrl?: string | null;
  defaultBranch: string;
  language?: string | null;
  license?: string | null;
  topics: string[];
  hasReadme: boolean;
  githubCreatedAt: Date;
  githubPushedAt?: Date | null;
  isFork: boolean;
  isArchived: boolean;
  isTemplate: boolean;
  isMirror: boolean;
}

export class RepositoryStore {
  public constructor(private readonly pool: Queryable) {}

  public async upsert(input: RepositoryInput): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `insert into ace_hunter.repositories (
         github_repo_id,github_node_id,owner_id,owner_login,owner_type,
         owner_profile_url,owner_avatar_url,name,full_name,description,repo_url,
         homepage_url,default_branch,language,license,topics,has_readme,
         github_created_at,github_pushed_at,is_fork,is_archived,is_template,is_mirror,
         status,last_synced_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,
         $18,$19,$20,$21,$22,$23,'active',now()
       )
       on conflict (github_repo_id) do update set
         github_node_id=excluded.github_node_id,
         owner_id=excluded.owner_id,
         owner_login=excluded.owner_login,
         owner_type=excluded.owner_type,
         owner_profile_url=excluded.owner_profile_url,
         owner_avatar_url=excluded.owner_avatar_url,
         name=excluded.name,
         full_name=excluded.full_name,
         description=excluded.description,
         repo_url=excluded.repo_url,
         homepage_url=excluded.homepage_url,
         default_branch=excluded.default_branch,
         language=excluded.language,
         license=excluded.license,
         topics=excluded.topics,
         has_readme=excluded.has_readme,
         github_created_at=excluded.github_created_at,
         github_pushed_at=excluded.github_pushed_at,
         is_fork=excluded.is_fork,
         is_archived=excluded.is_archived,
         is_template=excluded.is_template,
         is_mirror=excluded.is_mirror,
         status='active',
         last_synced_at=now(),
         updated_at=now()
       returning id`,
      [
        input.githubRepoId,
        input.githubNodeId ?? null,
        input.ownerId ?? null,
        input.ownerLogin,
        input.ownerType ?? null,
        input.ownerProfileUrl ?? null,
        input.ownerAvatarUrl ?? null,
        input.name,
        input.fullName,
        input.description ?? null,
        input.repoUrl,
        input.homepageUrl ?? null,
        input.defaultBranch,
        input.language ?? null,
        input.license ?? null,
        JSON.stringify(input.topics),
        input.hasReadme,
        input.githubCreatedAt,
        input.githubPushedAt ?? null,
        input.isFork,
        input.isArchived,
        input.isTemplate,
        input.isMirror,
      ],
    );
    return result.rows[0].id;
  }
}
