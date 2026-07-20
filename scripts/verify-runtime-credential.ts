import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { parse } from "dotenv";

export async function verifyRuntimeCredential(connectionString: string): Promise<void> {
  let pool: Pool | undefined;
  try {
    pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
    await pool.query("select 1");
    await pool.query("begin");
    try {
      await pool.query("create temporary table ace_hunter_credential_probe(value integer) on commit drop");
      await pool.query("insert into ace_hunter_credential_probe(value) values (1)");
      await pool.query("rollback");
    } catch (error) {
      await pool.query("rollback").catch(() => undefined);
      throw error;
    }
  } catch {
    throw new Error("database_credential_invalid");
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let connectionString = args[0];
  if (args[0] === "--env-file" && args[1]) connectionString = parse(await readFile(args[1], "utf8")).ACE_HUNTER_RUNTIME_DATABASE_URL;
  if (!connectionString || connectionString.includes("\n") || connectionString.includes("\r")) throw new Error("usage_error");
  await verifyRuntimeCredential(connectionString);
  process.stdout.write("runtime_credential_verified\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
