import { z } from "zod";

const nonnegativeInteger = z.number().int().nonnegative();

export const twitterAuthorSchema = z.object({
  id: z.string().regex(/^\d+$/),
  name: z.string().min(1).max(200),
  screenName: z.string().regex(/^[A-Za-z0-9_]{1,50}$/),
  verified: z.boolean().optional().default(false),
});

export const twitterMetricsSchema = z.object({
  likes: nonnegativeInteger.optional().default(0),
  retweets: nonnegativeInteger.optional().default(0),
  replies: nonnegativeInteger.optional().default(0),
  quotes: nonnegativeInteger.optional().default(0),
  views: nonnegativeInteger.nullable().optional().default(null),
  bookmarks: nonnegativeInteger.nullable().optional().default(null),
});

export const twitterTweetSchema = z.object({
  id: z.string().regex(/^\d+$/),
  text: z.string().max(100_000),
  author: twitterAuthorSchema,
  metrics: twitterMetricsSchema,
  createdAtISO: z.string().optional(),
  createdAt: z.string().optional(),
  lang: z.string().min(1).max(32).nullable().optional(),
  isRetweet: z.boolean().optional().default(false),
  articleText: z.string().max(500_000).optional(),
  articleTitle: z.string().max(10_000).optional(),
}).refine((value) => value.createdAtISO !== undefined || value.createdAt !== undefined);

export const twitterTweetListSchema = z.array(twitterTweetSchema);

export const twitterArticleSchema = twitterTweetSchema.and(z.object({
  articleText: z.string(),
}));

export const twitterStatusSchema = z.object({
  authenticated: z.literal(true),
  user: z.unknown().optional(),
});

export const twitterEnvelopeSchema = z.object({
  ok: z.boolean(),
  schema_version: z.string(),
  data: z.unknown(),
});
