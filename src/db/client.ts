import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "./schema.js";

/** Create a typed Kysely instance backed by a pg Pool. */
export function createDb(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: databaseUrl }),
    }),
  });
}

/** Close the underlying pg pool. Idempotent per db instance. */
export async function closeDb(db: Kysely<Database>): Promise<void> {
  await db.destroy();
}
