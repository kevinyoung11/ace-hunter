export interface ProductCandidate {
  readonly id: string;
  readonly name: string;
}

export interface ResolverStore {
  byGithubFullName(value: string): Promise<readonly ProductCandidate[]>;
  byName(value: string): Promise<readonly ProductCandidate[]>;
}

export interface ResolverOptions {
  createFromGithub?: (fullName: string) => Promise<{ productId: string }>;
}

export type ProductResolution =
  | { kind: "found"; productId: string; created?: true }
  | { kind: "ambiguous"; candidates: ProductCandidate[] }
  | { kind: "not_found" };

const fullNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function resolveProduct(
  store: ResolverStore,
  input: string,
  options: ResolverOptions = {},
): Promise<ProductResolution> {
  const target = parseTarget(input);
  if (target === null) return { kind: "not_found" };
  const rows = target.kind === "github"
    ? await store.byGithubFullName(target.value)
    : await store.byName(target.value);
  const candidates = normalizeCandidates(rows);
  if (candidates.length === 1) return { kind: "found", productId: candidates[0].id };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  if (target.kind === "github" && target.explicitUrl && options.createFromGithub) {
    const created = await options.createFromGithub(target.value);
    if (!validIdentifier(created.productId)) throw new Error("invalid_created_product");
    return { kind: "found", productId: created.productId, created: true };
  }
  return { kind: "not_found" };
}

type ParsedTarget = { kind: "github"; value: string; explicitUrl: boolean } | { kind: "name"; value: string };

function parseTarget(input: string): ParsedTarget | null {
  const value = input.trim();
  if (value.length === 0 || value.length > 512 || hasControlCharacter(value)) return null;
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    if (!isHttpProtocol(url.protocol) || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return fullNamePattern.test(path) ? { kind: "github", value: path, explicitUrl: true } : null;
  }
  if (fullNamePattern.test(value)) return { kind: "github", value, explicitUrl: false };
  if (value.includes("/") || value.includes("\\")) return null;
  return { kind: "name", value };
}

function normalizeCandidates(rows: readonly ProductCandidate[]): ProductCandidate[] {
  const unique = new Map<string, ProductCandidate>();
  for (const row of rows) {
    if (!validIdentifier(row.id) || typeof row.name !== "string" || row.name.trim().length === 0) throw new Error("invalid_resolver_result");
    unique.set(row.id, { id: row.id, name: row.name });
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function validIdentifier(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function isHttpProtocol(value: string): boolean {
  return value === "http:" || value === "https:";
}
