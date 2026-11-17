import { D1Database } from "./d1.ts";
import type { Database } from "./database.ts";
import { SCHEMA_VERSION } from "./schema.ts";

/** The schema mark this build writes and expects. */
export const SCHEMA_MARK = `gateway-${SCHEMA_VERSION}`;

export interface DatabaseStatus {
  backend: "D1" | "SQLite";
  /** The newest schema mark the database holds, or null before any schema was made. */
  schema: string | null;
}

/** Which backend this is and the schema it holds; it reads only. */
export async function databaseStatus(db: Database): Promise<DatabaseStatus> {
  await db.check();
  const backend = db instanceof D1Database ? "D1" : "SQLite";
  const table = await db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
  );
  if (table.length === 0) return { backend, schema: null };
  const marks = (await db.query("SELECT id FROM schema_migrations"))
    .map((row) => String(row.id))
    .filter((id) => id.startsWith("gateway-"))
    // gateway-9 must sort before gateway-21.
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  return { backend, schema: marks.at(-1) ?? null };
}
