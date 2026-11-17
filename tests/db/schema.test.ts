import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import { ConflictError, updateVersioned } from "../../src/db/rows.js";
import { ensureSchema, SCHEMA_VERSION } from "../../src/db/schema.js";
import { SqliteDatabase } from "../../src/db/sqlite.js";
import { type Backend, backends, database } from "../support/fakeD1.js";

const FIXTURE = new URL("../fixtures/existing-instance.sqlite3", import.meta.url);

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const fresh = () => {
    const made = database(kind);
    open.push(made.db);
    return made.db;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  it("applies the schema twice without error", async () => {
    const db = fresh();
    await ensureSchema(db);
    await ensureSchema(db);
    const marks = await db.query("SELECT id FROM schema_migrations");
    expect(marks).toEqual([{ id: `gateway-${SCHEMA_VERSION}` }]);
    const tables = await db.query("SELECT name FROM sqlite_master WHERE name = 'jobs'");
    expect(tables).toHaveLength(1);
  });

  async function things(): Promise<Database> {
    const db = fresh();
    await db.run(
      "CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT, version INTEGER NOT NULL)",
    );
    await db.run("INSERT INTO things VALUES (1, 'a', 0)");
    return db;
  }

  it("compare and swap retries a lost race", async () => {
    const db = await things();
    let calls = 0;
    const row = await updateVersioned(db, "things", { id: 1 }, async (current) => {
      calls += 1;
      if (calls === 1) await db.run("UPDATE things SET name = 'rival', version = version + 1");
      current.name = `${String(current.name)}+mine`;
    });
    expect(calls).toBe(2);
    expect(row).toEqual({ id: 1, name: "rival+mine", version: 2 });
    expect(await db.query("SELECT * FROM things")).toEqual([row]);
  });

  it("compare and swap gives up after 10 attempts", async () => {
    const db = await things();
    let calls = 0;
    const error = await updateVersioned(db, "things", { id: 1 }, async (current) => {
      calls += 1;
      await db.run("UPDATE things SET version = version + 1");
      current.name = "never";
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe('things {"id":1} kept changing; try again.');
    expect(calls).toBe(10);
  });
});

describe("sqlite file", () => {
  const folders: string[] = [];
  const dbs: SqliteDatabase[] = [];
  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((db) => db.close()));
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  const copyOfFixture = () => {
    const folder = mkdtempSync(join(tmpdir(), "schema-"));
    folders.push(folder);
    const path = join(folder, "gateway.sqlite3");
    copyFileSync(FIXTURE, path);
    const db = new SqliteDatabase(path);
    dbs.push(db);
    return db;
  };

  it("opens an existing database unchanged", async () => {
    const db = copyOfFixture();
    await ensureSchema(db);
    const bots = await db.query("SELECT id, name FROM bots");
    expect(bots).toEqual([{ id: "459cd5ecbc184b4185f344c108e9843d", name: "Chief of Staff" }]);
    expect(await db.query("SELECT id, task FROM jobs")).toEqual([{ id: 1, task: "daily summary" }]);
    const credentials = await db.query("SELECT account, kind, name FROM credentials");
    expect(credentials).toEqual([
      { account: "fae71f0394c64dfda62aac5441a068ad", kind: "model", name: "openai" },
    ]);
    expect(await db.query("SELECT id FROM web_runs")).toEqual([{ id: "run-fixture-1" }]);
    expect(await db.query("PRAGMA user_version")).toEqual([{ user_version: 21 }]);
  });

  it("refuses a schema it cannot upgrade", async () => {
    const older = new SqliteDatabase(":memory:");
    dbs.push(older);
    await older.run("PRAGMA user_version = 3");
    await expect(ensureSchema(older)).rejects.toThrow("This database needs upgrading to schema 21");
    const newer = new SqliteDatabase(":memory:");
    dbs.push(newer);
    await newer.run("PRAGMA user_version = 22");
    await expect(ensureSchema(newer)).rejects.toThrow("This database was written by a later version of bott; update bott to open it");
  });
});
