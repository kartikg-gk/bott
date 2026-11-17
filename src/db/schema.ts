import { basename, dirname, extname, join } from "node:path";
import type { Database } from "./database.js";
import { SCHEMA_SQL } from "./schemaSql.js";
import { SqliteDatabase } from "./sqlite.js";
import { applyHostedUpgrades, applyUpgrades, oldestUpgradable } from "./upgrades.js";

export const SCHEMA_VERSION = 21;

const MARKER = `gateway-${SCHEMA_VERSION}`;
const NEWER = "This database was written by a later version of bott; update bott to open it";
const MIGRATIONS_TABLE = "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY)";

/** The create statements, one string each. */
function statements(): string[] {
  return SCHEMA_SQL.split(/;\r?\n(?=CREATE )/)
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

async function mark(db: Database): Promise<void> {
  await db.run(MIGRATIONS_TABLE);
  await db.run("INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)", [MARKER]);
}

/**
 * Copies the file aside before its first upgrade step, as `<name>.before-v21-<ms><ext>` in the
 * same folder, so a step that goes wrong never costs the only copy.
 */
async function keepCopy(file: SqliteDatabase): Promise<void> {
  if (file.path === "" || file.path === ":memory:") return;
  const ext = extname(file.path);
  const stem = basename(file.path, ext);
  const target = join(
    dirname(file.path),
    `${stem}.before-v${SCHEMA_VERSION}-${Date.now()}${ext || ".sqlite3"}`,
  );
  await file.copyTo(target);
}

/**
 * A local file says its version in `user_version`. An empty file gets the whole schema; a file
 * from schema 1 to 20 is copied aside, then upgraded one step at a time. Markers that older
 * builds left in `schema_migrations` stay and are not checked here.
 */
async function ensureFile(file: SqliteDatabase): Promise<void> {
  const version = Number((await file.query("PRAGMA user_version"))[0]?.user_version ?? 0);
  if (version > SCHEMA_VERSION) throw new Error(NEWER);
  if (version === 0) {
    const existing = await file.query(
      "SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    );
    if (Number(existing[0]?.n) > 0) {
      throw new Error("This database has tables but no schema version, so it cannot be upgraded");
    }
    await create(file);
    await file.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } else if (version < SCHEMA_VERSION) {
    if (version < oldestUpgradable()) {
      throw new Error(
        `This database is at schema ${version}; the oldest this gateway upgrades is ` +
          `${oldestUpgradable()}`,
      );
    }
    await keepCopy(file);
    await applyUpgrades(file, version);
  }
  await mark(file);
}

/**
 * A hosted database cannot report `user_version`, so its markers say what it holds. One with
 * the current marker is left alone and one with no marker gets the whole schema. One that an
 * older build set up is taken through the same steps as a local file, one request at a time,
 * and gets the current marker only after the last of them; until then, opening it again
 * carries on from wherever the previous attempt stopped.
 */
async function ensureHosted(db: Database): Promise<void> {
  await db.run(MIGRATIONS_TABLE);
  const applied = (await db.query("SELECT id FROM schema_migrations")).map((row) => String(row.id));
  if (applied.includes(MARKER)) return;
  const versions = applied
    .map((id) => /^gateway-(\d+)$/.exec(id)?.[1])
    .filter((found): found is string => found !== undefined)
    .map(Number);
  if (versions.length === 0) {
    await create(db);
    await mark(db);
    return;
  }
  const version = Math.max(...versions);
  if (version > SCHEMA_VERSION) throw new Error(NEWER);
  if (version < oldestUpgradable()) {
    throw new Error(
      `Hosted database is at schema ${version}; the oldest this gateway upgrades is ` +
        `${oldestUpgradable()}`,
    );
  }
  await applyHostedUpgrades(db, version);
  await mark(db);
}

/** Brings the database to schema 21. Safe to repeat. */
export async function ensureSchema(db: Database): Promise<void> {
  if (db instanceof SqliteDatabase) await ensureFile(db);
  else await ensureHosted(db);
}
