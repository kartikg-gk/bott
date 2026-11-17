import { readFileSync } from "node:fs";
import type { Database } from "./database.js";
import { SqliteDatabase } from "./sqlite.js";

export const SCHEMA_VERSION = 21;

const MARKER = `gateway-${SCHEMA_VERSION}`;
const MIGRATIONS_TABLE = "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY)";

/** The create statements in schema.sql. Each starts at the left edge with CREATE and ends with ";". */
function statements(): string[] {
  const text = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  return text
    .split(/;\r?\n(?=CREATE )/)
    .map((statement) => statement.trim().replace(/;$/, ""))
    .filter((statement) => statement.length > 0);
}

async function create(db: Database): Promise<void> {
  for (const statement of statements()) {
    try {
      await db.run(statement);
    } catch (error) {
      // Another process, or an earlier run that stopped part way, already made it.
      if (!/already exists/i.test((error as Error).message)) throw error;
    }
  }
}

async function checkSqliteVersion(db: Database): Promise<boolean> {
  const version = Number((await db.query("PRAGMA user_version"))[0]?.user_version ?? 0);
  if (version > SCHEMA_VERSION) throw new Error("This database was written by a later version of bott; update bott to open it");
  if (version === SCHEMA_VERSION) return false;
  const existing = await db.query(
    "SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
  if (version !== 0 || Number(existing[0]?.n) > 0) {
    throw new Error(`This database needs upgrading to schema ${SCHEMA_VERSION}`);
  }
  return true;
}

/**
 * Brings the database to schema 21 and is safe to repeat. A SQLite file already at schema 21
 * opens as it is; older files must be upgraded first.
 */
export async function ensureSchema(db: Database): Promise<void> {
  const local = db instanceof SqliteDatabase;
  // A file already at 21 has its tables; anything else reaching here is empty.
  const needsCreate = local ? await checkSqliteVersion(db) : true;
  await db.run(MIGRATIONS_TABLE);
  const applied = (await db.query("SELECT id FROM schema_migrations")).map((row) => String(row.id));
  if (!local && applied.includes(MARKER)) return;
  const earlier = applied.filter((id) => id.startsWith("gateway-") && id !== MARKER).sort();
  if (earlier.length > 0) {
    throw new Error(
      `Hosted database is at ${earlier.at(-1)}; upgrading it to ${MARKER} is not supported yet`,
    );
  }
  if (needsCreate) await create(db);
  if (local && needsCreate) await db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  await db.run("INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)", [MARKER]);
}
