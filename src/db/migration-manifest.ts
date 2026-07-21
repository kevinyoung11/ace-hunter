import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const migrations = [
  { id: "0001_ace_hunter_initial", file: "0001_ace_hunter_initial.sql" },
  { id: "0002_vercel_ops_control_plane", file: "0002_vercel_ops_control_plane.sql" },
] as const;

export type MigrationId = (typeof migrations)[number]["id"];

export interface LoadedMigration {
  id: MigrationId;
  sql: string;
  checksum: string;
}

export async function loadMigrations(
  firstMigrationSqlOverride?: string,
): Promise<LoadedMigration[]> {
  return Promise.all(
    migrations.map(async (migration, index) => {
      const sql =
        index === 0 && firstMigrationSqlOverride !== undefined
          ? firstMigrationSqlOverride
          : await readFile(
              fileURLToPath(new URL(`./migrations/${migration.file}`, import.meta.url)),
              "utf8",
            );
      return {
        id: migration.id,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}
