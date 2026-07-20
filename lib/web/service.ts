import { Pool } from "pg";
import { createStoredFactsService } from "../../src/web/stored-facts-service";
import { loadWebConfig } from "./environment";

let pool: Pool | undefined;

export function webService() {
  const config = loadWebConfig(process.env);
  pool ??= new Pool({ connectionString: config.runtimeDatabaseUrl, max: 3, statement_timeout: 30_000 });
  return createStoredFactsService({ pool, userId: config.ownerUserId });
}
