import { expect, it } from "vitest";
import { githubRepositorySchema, mapGitHubRepository } from "../../../../src/sources/github/schemas.js";

const value = {
  id: 1, node_id: "R_1", name: "repo", full_name: "owner/repo", private: false,
  owner: { id: 2, login: "owner", type: "Organization", html_url: "https://github.com/owner", avatar_url: "https://avatars.githubusercontent.com/u/2" },
  html_url: "https://github.com/owner/repo", description: "d", fork: false,
  created_at: "2026-07-18T00:00:00Z", pushed_at: null, homepage: "http://127.0.0.1/admin",
  stargazers_count: 10, forks_count: 0, archived: false, disabled: false, visibility: "public",
  mirror_url: null, is_template: true, default_branch: "main", language: null, license: null, topics: [],
};

it("accepts templates but removes unsafe homepage URLs", () => {
  expect(mapGitHubRepository(githubRepositorySchema.parse(value))).toMatchObject({ isTemplate: true, homepageUrl: null });
});

it("rejects API identity URLs that do not match owner and full name", () => {
  const mismatched = githubRepositorySchema.parse({ ...value, html_url: "https://evil.example/owner/repo" });
  expect(() => mapGitHubRepository(mismatched)).toThrow(/repository_identity_invalid/);
});
