import { XSourceError } from "./x-source.js";

export interface ProductQueryInput {
  name: string;
  fullName: string;
  repoUrl: string;
  domain: string | null;
  isGenericName: boolean;
}

const fullNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const hostnamePattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function fail(): never {
  throw new XSourceError("x_query_invalid");
}

function safePhrase(value: string): string {
  const sanitized = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return character === '"' || character === "\\" || code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length === 0 || sanitized.length > 100) fail();
  return `"${sanitized}"`;
}

export function buildProductQueries(input: ProductQueryInput): string[] {
  const fullName = input.fullName.trim();
  if (!fullNamePattern.test(fullName)) fail();

  let repositoryUrl: URL;
  try {
    repositoryUrl = new URL(input.repoUrl);
  } catch {
    fail();
  }
  if (
    repositoryUrl.protocol !== "https:"
    || repositoryUrl.hostname !== "github.com"
    || repositoryUrl.username !== ""
    || repositoryUrl.password !== ""
    || repositoryUrl.search !== ""
    || repositoryUrl.hash !== ""
    || repositoryUrl.pathname !== `/${fullName}`
  ) fail();

  const domain = input.domain?.trim().toLowerCase() ?? null;
  if (domain !== null && !hostnamePattern.test(domain)) fail();

  const name = safePhrase(input.name);
  const queries = [
    safePhrase(repositoryUrl.href.replace(/\/$/, "")),
    safePhrase(fullName),
    ...(domain === null ? [] : [safePhrase(domain)]),
    `${name} GitHub`,
    `${name} "open source"`,
  ];
  return [...new Set(queries)];
}
