/**
 * Files at older schema versions, made in the test from the schema-21 shared fixture: each step
 * back takes out what that version added (tables, columns, indexes), so the rows that remain are
 * the ones a file at that version held. A file stepped back to N is what an install that
 * stopped at N left behind.
 */

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { ensureSchema } from "../../src/db/schema.ts";
import { SqliteDatabase } from "../../src/db/sqlite.ts";

export const SHARED_FIXTURE = fileURLToPath(
  new URL("../fixtures/shared-instance.sqlite3", import.meta.url),
);

type Row = Record<string, unknown>;

/** What stepping back from version N to N-1 removes, for N from 4 to 21. */
const STEP_BACK: Record<number, string[]> = {
  21: ["DROP TABLE run_context"],
  20: ["DROP TABLE leases"],
  19: ["DROP TABLE bot_memory", "DROP TABLE skill_files"],
  18: ["jobs", "web_runs", "approvals", "inbox", "delegations", "scheduler_leases"].map(
    (table) => `ALTER TABLE ${table} DROP COLUMN version`,
  ),
  17: ["DROP TABLE model_spend"],
  16: [
    "DROP TRIGGER cancel_queued_wakeups",
    "DROP TABLE job_wakeups",
    "DROP TABLE job_event_receipts",
    "DROP TABLE job_automation",
  ],
  15: ["DROP TABLE memory_index_epochs"],
  14: ["DROP TABLE web_run_events", "DROP TABLE web_runs", "DROP TABLE web_bot_routes"],
  13: [
    "DROP INDEX jobs_actor",
    "ALTER TABLE jobs DROP COLUMN last_answer",
    "DROP TABLE scheduler_leases",
  ],
  12: ["DROP TABLE bot_profiles", "DROP TABLE bot_sessions", "DROP TABLE bot_chat"],
  11: ["DROP TABLE model_requests"],
  10: ["DROP TABLE memory_facts"],
  9: ["DROP TABLE tasks", "ALTER TABLE bots DROP COLUMN temporary"],
  8: ["DROP TABLE bot_plugins"],
  7: ["DROP TABLE jobs"],
  6: ["DROP TABLE delegations"],
  5: ["DROP TABLE route_bots", "DROP TABLE bots", "ALTER TABLE routes DROP COLUMN bot"],
  4: [
    "DROP INDEX inbox_pending",
    "ALTER TABLE inbox DROP COLUMN route_user",
    "DROP TABLE routes",
    "DROP TABLE messages",
    "DROP TABLE instance_archive",
    "DROP TABLE imports",
  ],
};

/**
 * Before 3 a chat had no threads. Version 2 here keeps a thread-less session_owners table and
 * version 1 has none, so both shapes a file of that age can have are covered.
 */
function beforeThreads(version: number): string[] {
  return [
    "CREATE TABLE conversations_old(instance TEXT,chat INTEGER,user INTEGER,session TEXT," +
      "persisted INTEGER DEFAULT 0,PRIMARY KEY(instance,chat,user))",
    "INSERT OR IGNORE INTO conversations_old " +
      "SELECT instance,chat,user,session,persisted FROM conversations",
    "DROP TABLE conversations",
    "ALTER TABLE conversations_old RENAME TO conversations",
    "ALTER TABLE inbox DROP COLUMN thread",
    "ALTER TABLE approvals DROP COLUMN thread",
    ...(version === 2
      ? ["ALTER TABLE session_owners DROP COLUMN thread"]
      : ["DROP TABLE session_owners", "DROP TABLE session_status"]),
  ];
}

/** Steps the file at `path`, which must be at schema 21, back to `version` (1 to 21). */
export function stepBack(path: string, version: number): void {
  const db = new BetterSqlite3(path);
  try {
    const work: string[] = [];
    for (let at = 21; at > Math.max(version, 3); at -= 1) work.push(...(STEP_BACK[at] ?? []));
    if (version < 3) work.push(...beforeThreads(version));
    db.transaction(() => {
      for (const statement of work) db.exec(statement);
      db.exec("DROP TABLE IF EXISTS schema_migrations");
    })();
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
  }
}

/** Every row of every table, by table, apart from SQLite's own and the markers. */
export function allRows(path: string): Record<string, Row[]> {
  const db = new BetterSqlite3(path, { readonly: true });
  try {
    db.defaultSafeIntegers(true);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' " +
          "AND name <> 'schema_migrations' ORDER BY name",
      )
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all() as Row[]]),
    );
  } finally {
    db.close();
  }
}

/**
 * A copy of the shared fixture stepped back to `version`, opened and upgraded here, and then
 * given back every row the schema-21 original held. What is left is a schema built by the
 * upgrade steps holding the fixture's data, for checks that read rows the older file lacked.
 */
export async function upgradedCopy(folder: string, version: number): Promise<string> {
  const path = join(folder, `upgraded-from-${version}.sqlite3`);
  copyFileSync(SHARED_FIXTURE, path);
  const original = allRows(path);
  stepBack(path, version);
  const file = new SqliteDatabase(path);
  try {
    await ensureSchema(file);
  } finally {
    await file.close();
  }
  const db = new BetterSqlite3(path);
  try {
    db.defaultSafeIntegers(true);
    // Rows go back table by table, so a child row may land before its parent.
    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      for (const [table, rows] of Object.entries(original)) {
        db.exec(`DELETE FROM "${table}"`);
        for (const row of rows) {
          const names = Object.keys(row);
          db.prepare(
            `INSERT INTO "${table}"(${names.map((n) => `"${n}"`).join(",")}) ` +
              `VALUES (${names.map(() => "?").join(",")})`,
          ).run(...names.map((n) => row[n]));
        }
      }
    })();
    db.pragma("journal_mode = DELETE");
  } finally {
    db.close();
  }
  return path;
}
