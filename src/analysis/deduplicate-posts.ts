import type { XPostFact } from "../sources/x/x-source.js";

const standaloneHttpUrl = /(^|[^\p{L}\p{N}_])https?:\/\/[^\s<>"']+/gu;

export function contentDeduplicationKey(text: string): string | null {
  const key = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(standaloneHttpUrl, "$1")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
  return key === "" ? null : key;
}

export function deduplicatePosts(
  posts: ReadonlyArray<XPostFact>,
): Array<XPostFact & { duplicateClusterId: string | null }> {
  const representatives = new Map<string, string>();
  return posts.map((post) => {
    const key = contentDeduplicationKey(post.content);
    // URL-only and whitespace-only posts contain no stable semantic key. Treating all
    // of them as one cluster would manufacture duplicates from unrelated links.
    if (key === null) return { ...post, duplicateClusterId: null };
    const representativeId = representatives.get(key);
    if (representativeId === undefined) representatives.set(key, post.id);
    return { ...post, duplicateClusterId: representativeId ?? null };
  });
}
