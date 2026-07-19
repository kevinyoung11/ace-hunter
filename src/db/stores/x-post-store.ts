import type { Queryable } from "./queryable.js";

export class XPostStore {
  public constructor(private readonly pool: Queryable) {}

  public async upsert(input: {
    productId: string;
    repositoryId?: string | null;
    xPostId: string;
    conversationId?: string | null;
    rootPostId?: string | null;
    inReplyToPostId?: string | null;
    postType: "original" | "comment" | "article";
    authorId: string;
    authorUsername: string;
    authorName?: string | null;
    authorVerified?: boolean | null;
    content: string;
    language?: string | null;
    postUrl: string;
    xCreatedAt: Date;
    likes: number;
    reposts: number;
    quotes: number;
    replies: number;
    bookmarks?: number | null;
    views?: number | null;
  }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `insert into ace_hunter.product_x_posts (
         product_id,repository_id,x_post_id,conversation_id,root_post_id,
         in_reply_to_post_id,post_type,author_id,author_username,author_name,
         author_verified,content,language,post_url,x_created_at,likes,reposts,
         quotes,replies,bookmarks,views,metrics_updated_at,last_synced_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,now(),now()
       )
       on conflict (product_id,x_post_id) do update set
         repository_id=excluded.repository_id,conversation_id=excluded.conversation_id,
         root_post_id=excluded.root_post_id,in_reply_to_post_id=excluded.in_reply_to_post_id,
         post_type=excluded.post_type,author_id=excluded.author_id,
         author_username=excluded.author_username,author_name=excluded.author_name,
         author_verified=excluded.author_verified,content=excluded.content,
         language=excluded.language,post_url=excluded.post_url,
         x_created_at=excluded.x_created_at,likes=excluded.likes,reposts=excluded.reposts,
         quotes=excluded.quotes,replies=excluded.replies,bookmarks=excluded.bookmarks,
         views=excluded.views,metrics_updated_at=now(),last_synced_at=now(),updated_at=now()
       returning id`,
      [
        input.productId,
        input.repositoryId ?? null,
        input.xPostId,
        input.conversationId ?? null,
        input.rootPostId ?? null,
        input.inReplyToPostId ?? null,
        input.postType,
        input.authorId,
        input.authorUsername,
        input.authorName ?? null,
        input.authorVerified ?? null,
        input.content,
        input.language ?? null,
        input.postUrl,
        input.xCreatedAt,
        input.likes,
        input.reposts,
        input.quotes,
        input.replies,
        input.bookmarks ?? null,
        input.views ?? null,
      ],
    );
    return result.rows[0].id;
  }
}
