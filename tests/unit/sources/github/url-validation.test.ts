import { describe, expect, it } from "vitest";
import { safePublicHomepage, validateGitHubIdentityUrls } from "../../../../src/sources/github/url-validation.js";

describe("GitHub URL validation", () => {
  it("binds repository and owner identity and canonicalizes official avatars", () => {
    expect(validateGitHubIdentityUrls({
      fullName: "Owner/Repo", ownerLogin: "Owner", repoUrl: "https://github.com/Owner/Repo",
      ownerUrl: "https://github.com/Owner", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    })).toEqual({
      repoUrl: "https://github.com/Owner/Repo", ownerUrl: "https://github.com/Owner",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
    });
  });

  it.each([
    "https://evilgithubusercontent.com/u/1",
    "https://github.com.evil.test/u/1",
    "https://avatars.githubusercontent.com:444/u/1",
    "https://avatars.githubusercontent.com/u/1?token=secret",
  ])("rejects untrusted avatar %s", (avatarUrl) => {
    expect(() => validateGitHubIdentityUrls({ fullName: "o/r", ownerLogin: "o", repoUrl: "https://github.com/o/r", ownerUrl: "https://github.com/o", avatarUrl })).toThrow(/repository_identity_invalid/);
  });

  it.each([
    "http://127.0.0.1/x", "http://169.254.169.254/x", "http://100.64.0.1/x",
    "http://[::1]/x", "http://[fd00::1]/x", "http://[::ffff:127.0.0.1]/x",
    "https://service.internal/x", "https://singlelabel/x", "ftp://example.com/x",
  ])("drops non-public homepage %s", (url) => expect(safePublicHomepage(url)).toBeNull());
});
