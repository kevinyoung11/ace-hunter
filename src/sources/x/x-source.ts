export interface XPostFact {
  id: string;
  conversationId: string;
  rootPostId: string;
  inReplyToPostId: string | null;
  authorId: string;
  authorUsername: string;
  authorName: string;
  authorVerified: boolean;
  content: string;
  language: string | null;
  url: string;
  createdAt: Date;
  likes: number;
  reposts: number;
  quotes: number;
  replies: number;
  bookmarks: number | null;
  views: number | null;
  /** True when content contains the CLI-expanded long-form Article body. */
  isArticle?: boolean;
}

export interface XSearchInput {
  query: string;
  since: Date;
  until: Date;
  limit: number;
}

export interface XSourceAdapter {
  capabilities(): { recentSearchDays: number; replies: boolean };
  assertAuthenticated(): Promise<void>;
  searchPosts(input: XSearchInput): Promise<XPostFact[]>;
  searchReplies(conversationId: string, since: Date, limit: number): Promise<XPostFact[]>;
  getArticle(tweetId: string): Promise<{ articleText: string }>;
}

export class XSourceError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "XSourceError";
  }
}
