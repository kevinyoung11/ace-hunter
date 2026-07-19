import { describe, expect, it } from "vitest";
import { deduplicatePosts } from "../../../src/analysis/deduplicate-posts.js";
import type { XPostFact } from "../../../src/sources/x/x-source.js";

function post(id: string, content: string): XPostFact {
  return {
    id,
    conversationId: id,
    rootPostId: id,
    inReplyToPostId: null,
    authorId: `author-${id}`,
    authorUsername: `user_${id}`,
    authorName: `User ${id}`,
    authorVerified: false,
    content,
    language: "en",
    url: `https://x.com/user_${id}/status/${id}`,
    createdAt: new Date("2026-07-19T00:00:00Z"),
    likes: 0,
    reposts: 0,
    quotes: 0,
    replies: 0,
    bookmarks: null,
    views: null,
  };
}

describe("deduplicatePosts", () => {
  it("keeps the first representative and points normalized duplicates to it", () => {
    const result = deduplicatePosts([
      post("representative", "  Shipping   Ace Hunter https://example.com/demo  "),
      post("duplicate", "shipping ace hunter https://example.org/other"),
      post("different", "Ace Hunter ships tomorrow"),
    ]);

    expect(result.map(({ id, duplicateClusterId }) => ({ id, duplicateClusterId }))).toEqual([
      { id: "representative", duplicateClusterId: null },
      { id: "duplicate", duplicateClusterId: "representative" },
      { id: "different", duplicateClusterId: null },
    ]);
  });

  it("normalizes Unicode compatibility forms and Unicode whitespace", () => {
    const result = deduplicatePosts([
      post("unicode-representative", "ＡＣＥ\u3000Hunter Café"),
      post("unicode-duplicate", "ace\n hunter cafe\u0301"),
    ]);

    expect(result[1].duplicateClusterId).toBe("unicode-representative");
  });

  it("removes only standalone HTTP URLs and does not merge empty normalized content", () => {
    const result = deduplicatePosts([
      post("url-a", "https://example.com/a"),
      post("url-b", " https://example.com/b \n"),
      post("boundary", "prehttps://example.com/a"),
      post("boundary-2", "prehttps://example.com/a"),
    ]);

    expect(result.map((item) => item.duplicateClusterId)).toEqual([
      null,
      null,
      null,
      "boundary",
    ]);
  });

  it("recognizes URLs after punctuation without treating embedded protocol text as a URL", () => {
    const result = deduplicatePosts([
      post("punctuation", "Demo:https://example.com/a Ace Hunter"),
      post("plain", "demo: ace hunter"),
      post("embedded", "demo: prehttps://example.com/a ace hunter"),
    ]);

    expect(result.map((item) => item.duplicateClusterId)).toEqual([null, "punctuation", null]);
  });

  it("does not mutate the source posts", () => {
    const input = [post("one", "Same"), post("two", "same")];
    const before = structuredClone(input);

    deduplicatePosts(input);

    expect(input).toEqual(before);
  });
});
