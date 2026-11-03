import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSchema, SCHEMA_VERSION } from "../../src/db/schema.ts";
import { SqliteDatabase } from "../../src/db/sqlite.ts";
import { UPGRADES } from "../../src/db/upgrades.ts";
import { FakeD1 } from "../support/fakeD1.ts";
import { allRows, SHARED_FIXTURE, stepBack } from "./olderFile.ts";

/** The versions a file can be found at and still be brought to 21 here. */
const OLDER = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

type Row = Record<string, unknown>;

/** How a table is made: its columns and indexes, in a form two files can be compared by. */
function shape(path: string): Record<string, unknown> {
  const db = new BetterSqlite3(path, { readonly: true });
  try {
    const out: Record<string, unknown> = {};
    const items = db
      .prepare(
        "SELECT type,name,tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' " +
          "AND name <> 'schema_migrations' ORDER BY type,name",
      )
      .all() as { type: string; name: string; tbl_name: string }[];
    for (const item of items) {
      if (item.type === "table") {
        out[`table ${item.name}`] = db
          .prepare(`SELECT name,type,"notnull",dflt_value,pk FROM pragma_table_info(?)`)
          .all(item.name);
      } else if (item.type === "index") {
        const listed = (
          db
            .prepare('SELECT name,"unique",partial FROM pragma_index_list(?)')
            .all(item.tbl_name) as { name: string }[]
        ).find((entry) => entry.name === item.name);
        const columns = db.prepare("SELECT name FROM pragma_index_info(?)").all(item.name);
        out[`index ${item.name}`] = { on: item.tbl_name, listed, columns };
      } else {
        out[`${item.type} ${item.name}`] = item.tbl_name;
      }
    }
    return out;
  } finally {
    db.close();
  }
}

/** Rows as sorted JSON, so two tables compare without caring about row order. */
function asSet(rows: Row[], columns: string[]): string[] {
  return rows
    .map((row) =>
      JSON.stringify(
        columns.map((name) => row[name]),
        (_, value) => (typeof value === "bigint" ? value.toString() : value),
      ),
    )
    .sort();
}

describe("upgrading a SQLite file from an older schema", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  function folder(): string {
    const made = mkdtempSync(join(tmpdir(), "upgrade-"));
    folders.push(made);
    return made;
  }

  function olderFile(version: number): string {
    const path = join(folder(), "gateway.sqlite3");
    copyFileSync(SHARED_FIXTURE, path);
    stepBack(path, version);
    return path;
  }

  async function open(path: string): Promise<void> {
    const db = new SqliteDatabase(path);
    try {
      await ensureSchema(db);
    } finally {
      await db.close();
    }
  }

  let freshShape: Record<string, unknown> | undefined;
  async function currentShape(): Promise<Record<string, unknown>> {
    if (!freshShape) {
      const path = join(folder(), "fresh.sqlite3");
      await open(path);
      // The fixture's account tables come from the account store, not the schema.
      const own = new Set(Object.keys(shape(path)));
      const fixture = shape(SHARED_FIXTURE);
      freshShape = Object.fromEntries(Object.entries(fixture).filter(([key]) => !own.has(key)));
      Object.assign(freshShape, shape(path));
    }
    return freshShape;
  }

  it("has one step for every version up to the current one", () => {
    expect(UPGRADES.at(-1)?.reaches).toBe(SCHEMA_VERSION);
    const reached = UPGRADES.map((step) => step.reaches);
    expect(reached).toEqual([...reached].sort((a, b) => a - b));
  });

  it.each(OLDER)("brings a file at schema %i to 21, keeping its rows", async (version) => {
    const path = olderFile(version);
    const before = allRows(path);
    await open(path);
    const db = new BetterSqlite3(path, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(db.prepare("SELECT id FROM schema_migrations").all()).toEqual([
        { id: `gateway-${SCHEMA_VERSION}` },
      ]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
    const after = allRows(path);
    for (const [table, rows] of Object.entries(before)) {
      const columns = Object.keys(rows[0] ?? {});
      const kept = asSet(after[table] ?? [], columns);
      // From before 4, chats that had a session also get an owner row.
      if (table === "session_owners" && version < 4) {
        expect(kept, table).toEqual(expect.arrayContaining(asSet(rows, columns)));
      } else {
        expect(kept, table).toEqual(asSet(rows, columns));
      }
    }
    expect(shape(path)).toEqual(await currentShape());
  });

  it.each(OLDER)("keeps a copy of the file at schema %i beside it", async (version) => {
    const path = olderFile(version);
    await open(path);
    const copies = readdirSync(join(path, "..")).filter((name) =>
      /^gateway\.before-v21-\d+\.sqlite3$/.test(name),
    );
    expect(copies).toHaveLength(1);
    const copy = new BetterSqlite3(join(path, "..", copies[0] as string), { readonly: true });
    try {
      expect(copy.pragma("user_version", { simple: true })).toBe(version);
    } finally {
      copy.close();
    }
  });

  it("adds write counters only where a file at 17 lacks them", async () => {
    const path = olderFile(17);
    const db = new BetterSqlite3(path);
    db.exec("ALTER TABLE inbox ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE inbox SET version = 4");
    db.close();
    await open(path);
    const after = new BetterSqlite3(path, { readonly: true });
    try {
      expect(after.prepare("SELECT DISTINCT version FROM inbox").all()).toEqual([{ version: 4 }]);
      expect(after.prepare("SELECT DISTINCT version FROM jobs").all()).toEqual([{ version: 0 }]);
    } finally {
      after.close();
    }
  });

  it("leaves a file at the last step that worked when a later one fails", async () => {
    const path = olderFile(11);
    const db = new BetterSqlite3(path);
    // The step to 13 adds this column, so finding it there already makes that step fail.
    db.exec("ALTER TABLE jobs ADD COLUMN last_answer TEXT");
    db.close();
    await expect(open(path)).rejects.toThrow(/duplicate column/);
    const after = new BetterSqlite3(path, { readonly: true });
    try {
      expect(after.pragma("user_version", { simple: true })).toBe(12);
      const names = after.prepare("SELECT name FROM sqlite_master").all();
      expect(names).toContainEqual({ name: "bot_profiles" });
      expect(names).not.toContainEqual({ name: "scheduler_leases" });
    } finally {
      after.close();
    }
  });

  it("makes no copy of a new or an up-to-date file", async () => {
    const place = folder();
    await open(join(place, "gateway.sqlite3"));
    await open(join(place, "gateway.sqlite3"));
    expect(readdirSync(place).filter((name) => name.includes("before"))).toEqual([]);
  });

  it("keeps the markers older builds wrote, and opens a file that has them", async () => {
    const path = olderFile(20);
    const db = new BetterSqlite3(path);
    db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)");
    db.exec("INSERT INTO schema_migrations VALUES ('gateway-18'),('gateway-19'),('gateway-20')");
    db.close();
    await open(path);
    await open(path);
    const marks = new BetterSqlite3(path, { readonly: true });
    try {
      expect(marks.prepare("SELECT id FROM schema_migrations ORDER BY id").all()).toEqual([
        { id: "gateway-18" },
        { id: "gateway-19" },
        { id: "gateway-20" },
        { id: "gateway-21" },
      ]);
    } finally {
      marks.close();
    }
  });

  it("refuses a file newer than this build, and one with tables but no version", async () => {
    const newer = new SqliteDatabase(":memory:");
    await newer.run("PRAGMA user_version = 22");
    await expect(ensureSchema(newer)).rejects.toThrow("This database was written by a later version of bott; update bott to open it");
    await newer.close();
    const unnumbered = new SqliteDatabase(":memory:");
    await unnumbered.run("CREATE TABLE notes(id INTEGER)");
    await expect(ensureSchema(unnumbered)).rejects.toThrow("tables but no schema version");
    await unnumbered.close();
  });

  it("refuses a hosted database an older build set up", async () => {
    const fake = new FakeD1();
    fake.connection.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)");
    fake.connection.exec("INSERT INTO schema_migrations VALUES ('gateway-20')");
    await expect(ensureSchema(fake.database())).rejects.toThrow(
      "Hosted database is at gateway-20; upgrading it to gateway-21 is not supported yet",
    );
    fake.connection.close();
  });
});
