import { Pool } from "pg";
import { createStoredFactsService } from "../../src/web/stored-facts-service";
import { readWebConfig } from "./environment";

let pool: Pool | undefined;

export function webService() {
  const config = readWebConfig();
  pool ??= new Pool({ connectionString: config.runtimeDatabaseUrl, max: 3, statement_timeout: 30_000 });
  return createStoredFactsService({ pool, userId: config.ownerUserId });
}
