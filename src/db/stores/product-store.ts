import type { Queryable } from "./queryable.js";

export class ProductStore {
  public constructor(private readonly pool: Queryable) {}

  public async create(input: {
    name: string;
    description?: string | null;
    websiteUrl?: string | null;
    identifiers?: Record<string, unknown>;
  }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `insert into ace_hunter.products(name,description,website_url,identifiers,status)
       values($1,$2,$3,$4::jsonb,'active') returning id`,
      [
        input.name,
        input.description ?? null,
        input.websiteUrl ?? null,
        JSON.stringify(input.identifiers ?? {}),
      ],
    );
    return result.rows[0].id;
  }

  public async linkRepository(input: {
    productId: string;
    repositoryId: string;
    role: "primary" | "secondary";
    isPrimary: boolean;
    confidence?: number | null;
    linkSource: string;
  }): Promise<void> {
    await this.pool.query(
      `insert into ace_hunter.product_repositories
         (product_id,repository_id,role,is_primary,confidence,link_source)
       values($1,$2,$3,$4,$5,$6)
       on conflict (product_id,repository_id) do update set
         role=excluded.role,is_primary=excluded.is_primary,
         confidence=excluded.confidence,link_source=excluded.link_source`,
      [
        input.productId,
        input.repositoryId,
        input.role,
        input.isPrimary,
        input.confidence ?? null,
        input.linkSource,
      ],
    );
  }
}
