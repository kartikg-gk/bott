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

/** Earlier messages a browser sent along with a hosted run, held until the run starts. */
const runContext: Upgrade = {
  reaches: 21,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS run_context(instance TEXT NOT NULL, inbox INTEGER NOT NULL, " +
      "conversation TEXT NOT NULL, PRIMARY KEY(instance,inbox))",
  ],
};

/** Every step, oldest first. The last one reaches the schema this build writes. */
export const UPGRADES: readonly Upgrade[] = [runContext];

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
