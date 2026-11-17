import type { SqliteDatabase } from "./sqlite.js";

/** What a step may ask about the file it is about to change. */
export interface FileFacts {
  /** The schema version the file had when it was opened. */
  from: number;
  columns(table: string): Promise<Set<string>>;
}

/** One schema step. Each runs in its own transaction and sets `user_version` to `reaches`. */
export interface Upgrade {
  reaches: number;
  /** The lowest version this step accepts; the version just below `reaches` unless set. */
  lowest?: number;
  statements(file: FileFacts): string[] | Promise<string[]>;
}

/** Tables whose rows count their writes, so an update only lands on the version it read. */
const COUNTED = ["jobs", "web_runs", "approvals", "inbox", "delegations", "scheduler_leases"];

/** A write counter on each shared row. A table that already has one is left as it is. */
const writeCounters: Upgrade = {
  reaches: 18,
  async statements(file) {
    const missing: string[] = [];
    for (const table of COUNTED) {
      if (!(await file.columns(table)).has("version")) missing.push(table);
    }
    return missing.map(
      (table) => `ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 0`,
    );
  },
};

/** Notes and skill files for hosted bots, whose folders do not outlast a request. */
const hostedFiles: Upgrade = {
  reaches: 19,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS bot_memory(instance TEXT NOT NULL, bot TEXT NOT NULL, " +
      "file TEXT NOT NULL, content TEXT NOT NULL, updated REAL NOT NULL, " +
      "PRIMARY KEY(instance,bot,file))",
    "CREATE TABLE IF NOT EXISTS skill_files(instance TEXT NOT NULL, scope TEXT NOT NULL, " +
      "skill TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, revision TEXT NOT NULL, " +
      "PRIMARY KEY(instance,scope,skill,path))",
  ],
};

/** Named leases that stand in for file locks when several processes share one database. */
const leases: Upgrade = {
  reaches: 20,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY, owner TEXT NOT NULL, " +
      "expires REAL NOT NULL)",
  ],
};

/** Earlier messages a browser sent along with a hosted run, held until the run starts. */
const runContext: Upgrade = {
  reaches: 21,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS run_context(instance TEXT NOT NULL, inbox INTEGER NOT NULL, " +
      "conversation TEXT NOT NULL, PRIMARY KEY(instance,inbox))",
  ],
};

/** Every step, oldest first. The last one reaches the schema this build writes. */
export const UPGRADES: readonly Upgrade[] = [writeCounters, hostedFiles, leases, runContext];

/** The oldest schema version a file can be at and still be brought up to date here. */
export function oldestUpgradable(): number {
  const first = UPGRADES[0] as Upgrade;
  return first.lowest ?? first.reaches - 1;
}

/** Applies every step the file has not had yet, one transaction per step. */
export async function applyUpgrades(file: SqliteDatabase, from: number): Promise<void> {
  const facts: FileFacts = {
    from,
    async columns(table) {
      const rows = await file.query(`SELECT name FROM pragma_table_info('${table}')`);
      return new Set(rows.map((row) => String(row.name)));
    },
  };
  for (const step of UPGRADES) {
    if (from >= step.reaches) continue;
    const body = (await step.statements(facts)).map((statement) => `${statement};\n`).join("");
    await file.script(`${body}PRAGMA user_version = ${step.reaches};`);
  }
}
