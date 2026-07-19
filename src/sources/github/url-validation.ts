import { isIP } from "node:net";

export function validateGitHubIdentityUrls(input: {
  fullName: string; ownerLogin: string; repoUrl: string; ownerUrl: string; avatarUrl: string;
}): { repoUrl: string; ownerUrl: string; avatarUrl: string } {
  const repo = strictHttpsUrl(input.repoUrl);
  const owner = strictHttpsUrl(input.ownerUrl);
  const avatar = strictHttpsUrl(input.avatarUrl, true);
  if (repo.hostname !== "github.com" || normalizedPath(repo) !== `/${input.fullName}`.toLowerCase() ||
      owner.hostname !== "github.com" || normalizedPath(owner) !== `/${input.ownerLogin}`.toLowerCase()) {
    throw new Error("repository_identity_invalid");
  }
  if (!(avatar.hostname === "avatars.githubusercontent.com" || avatar.hostname.endsWith(".githubusercontent.com"))) {
    throw new Error("repository_identity_invalid");
  }
  if (avatar.search && !/^\?v=\d+$/.test(avatar.search)) throw new Error("repository_identity_invalid");
  avatar.search = "";
  return { repoUrl: repo.toString(), ownerUrl: owner.toString(), avatarUrl: avatar.toString() };
}

export function safePublicHomepage(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (unsafeHost(host)) return null;
  return url.toString();
}

function strictHttpsUrl(value: string, allowAvatarQuery = false): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || (!allowAvatarQuery && url.search)) {
    throw new Error("repository_identity_invalid");
  }
  return url;
}

function normalizedPath(url: URL): string { return url.pathname.replace(/\/$/, "").toLowerCase(); }

function unsafeHost(host: string): boolean {
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || !host.includes(".") && isIP(host) === 0) return true;
  const family = isIP(host);
  if (family === 4) return unsafeIpv4(host);
  if (family === 6) return unsafeIpv6(host);
  return false;
}

function unsafeIpv4(host: string): boolean {
  const [a, b, c] = host.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
    a === 192 && b === 0 || a === 192 && b === 0 && c === 2 ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
    a === 203 && b === 0 && c === 113;
}

function unsafeIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") ||
      /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("2001:db8:") || lower.startsWith("::ffff:")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  return mapped ? unsafeIpv4(mapped[1]) : false;
}
