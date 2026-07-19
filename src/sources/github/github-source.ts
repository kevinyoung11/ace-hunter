export interface SearchSlice {
  from: Date;
  to: Date;
  minStars: number;
  maxStars?: number;
}

export type GitHubOwnerType = "User" | "Organization";

export interface GitHubRepository {
  githubRepoId: number;
  nodeId: string;
  ownerId: number;
  ownerLogin: string;
  ownerType: GitHubOwnerType;
  ownerProfileUrl: string;
  ownerAvatarUrl: string;
  name: string;
  fullName: string;
  description: string | null;
  repoUrl: string;
  homepageUrl: string | null;
  defaultBranch: string;
  language: string | null;
  license: string | null;
  topics: string[];
  hasReadme: boolean;
  createdAt: Date;
  pushedAt: Date | null;
  stars: number;
  forks: number;
  visibility: "public";
  isPrivate: false;
  isFork: boolean;
  isArchived: boolean;
  isTemplate: boolean;
  isMirror: boolean;
}

export interface GitHubSearchPage {
  totalCount: number;
  repositories: GitHubRepository[];
  /** Number of raw API items, including private hits deliberately excluded locally. */
  rawItemCount?: number;
  hasNextPage: boolean;
  nextPage: number | null;
}

export interface GitHubSource {
  getRateLimit(): Promise<{ remaining: number; resetAt: Date }>;
  searchRepositories(slice: SearchSlice, page: number): Promise<GitHubSearchPage>;
  getRepository(fullName: string): Promise<GitHubRepository>;
  hasReadme(fullName: string): Promise<boolean>;
}

export interface GitHubSourceOperation extends GitHubSource {
  close(): void | Promise<void>;
}

export interface GitHubSourceFactory {
  openOperation(): GitHubSourceOperation | Promise<GitHubSourceOperation>;
}

export class GitHubSourceError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "GitHubSourceError";
  }
}
