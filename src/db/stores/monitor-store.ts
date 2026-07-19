import type { Queryable } from "./queryable.js";

export class MonitorStore {
  public constructor(private readonly pool: Queryable) {}

  public async upsert(input: {
    userId: string;
    productId: string;
    status: "active" | "inactive";
  }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `insert into ace_hunter.user_product_monitors(user_id,product_id,status)
       values($1,$2,$3)
       on conflict (user_id,product_id) do update set
         status=excluded.status,updated_at=now()
       returning id`,
      [input.userId, input.productId, input.status],
    );
    return result.rows[0].id;
  }
}
