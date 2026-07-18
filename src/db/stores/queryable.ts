import type { Pool, PoolClient } from "pg";

export type Queryable = Pick<Pool | PoolClient, "query">;
