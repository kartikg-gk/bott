import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import {
  ConstraintError,
  createDatabase,
  DatabaseConfigError,
  inlineNulls,
} from "../../src/db/database.js";
import { SqliteDatabase } from "../../src/db/sqlite.js";
import { type Backend, backends, database, FakeD1 } from "../support/fakeD1.js";

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const fresh = () => {
    const made = database(kind);
    open.push(made.db);
    return made;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  it("round trips a query and a run", async () => {
    const { db } = fresh();
    await db.check();
    await db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB, n REAL)");
    await db.run("INSERT INTO t (id, name, data, n) VALUES (?, ?, ?, ?)", [
      1,
      "a",
      new Uint8Array([0, 1, 255]),
      2.5,
    ]);
    const rows = await db.query("SELECT * FROM t");
    expect(rows).toEqual([{ id: 1, name: "a", data: new Uint8Array([0, 1, 255]), n: 2.5 }]);
  });

  it("run reports changed rows", async () => {
    const { db } = fresh();
    await db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)");
    await db.run("INSERT INTO t VALUES (1, 0), (2, 0), (3, 5)");
    expect(await db.run("UPDATE t SET v = 1 WHERE v = 0")).toBe(2);
    expect(await db.run("UPDATE t SET v = 1 WHERE v = 99")).toBe(0);
  });

  it("null parameters are written as NULL", async () => {
    const { db } = fresh();
    await db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.run("INSERT INTO t VALUES (?, ?)", [1, null]);
    expect(await db.query("SELECT v FROM t WHERE id = ?", [1])).toEqual([{ v: null }]);
    expect(await db.query("SELECT 'what?' AS s, ? AS n", [null])).toEqual([
      { s: "what?", n: null },
    ]);
  });

  it("returns rows from a write with RETURNING", async () => {
    const { db } = fresh();
    await db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const rows = await db.query("INSERT INTO t VALUES (?, ?) RETURNING id", [7, "x"]);
    expect(rows).toEqual([{ id: 7 }]);
  });

  it("constraint failure is one type", async () => {
    const { db } = fresh();
    await db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await db.run("INSERT INTO t VALUES (1)");
    await expect(db.run("INSERT INTO t VALUES (1)")).rejects.toBeInstanceOf(ConstraintError);
  });

  it("bigint params round trip on both backends", async () => {
    const { db } = fresh();
    const big = 2n ** 60n + 1n;
    await db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.run("INSERT INTO t VALUES (?, ?)", [big, "x"]);
    await db.run("INSERT INTO t VALUES (?, ?)", [big + 1n, "y"]);
    const rows = await db.query("SELECT CAST(id AS TEXT) AS id, v FROM t WHERE id = ?", [big]);
    expect(rows).toEqual([{ id: big.toString(), v: "x" }]);
    expect(BigInt(String(rows[0]?.id))).toBe(big);
    const next = await db.query("SELECT CAST(max(id) + 1 AS TEXT) AS id FROM t");
    expect(BigInt(String(next[0]?.id))).toBe(big + 2n);
  });
});

describe("inlineNulls", () => {
  it("inlining skips question marks in quotes", () => {
    expect(inlineNulls("SELECT '?', \"a?\", ?, ?", [null, 2])).toEqual([
      "SELECT '?', \"a?\", NULL, ?",
      [2],
    ]);
  });

  it("writes bytes as hex literals", () => {
    expect(inlineNulls("SELECT ?, ?", [new Uint8Array([1, 171]), "x"])).toEqual([
      "SELECT X'01ab', ?",
      ["x"],
    ]);
  });
});

describe("D1 requests and errors", () => {
  it("sends numbers to D1 as text", async () => {
    const fake = new FakeD1();
    const db = fake.database();
    await db.run("CREATE TABLE t (a INTEGER, b REAL, c TEXT, d INTEGER)");
    await db.run("INSERT INTO t VALUES (?, ?, ?, ?)", [1, 2.5, "x", true]);
    for (const request of fake.requests) {
      for (const param of request.params) expect(typeof param).toBe("string");
    }
    expect(fake.requests[1]?.params).toEqual(["1", "2.5", "x", "1"]);
    expect(await db.query("SELECT * FROM t")).toEqual([{ a: 1, b: 2.5, c: "x", d: 1 }]);
  });

  it("D1 errors name D1", async () => {
    const fake = new FakeD1();
    const db = fake.database();
    fake.fault = () =>
      Response.json({ success: false, errors: [{ message: "boom" }] }, { status: 500 });
    await expect(db.query("SELECT 1")).rejects.toThrow(/^D1 query failed.*boom/);
    fake.fault = () => new Response("<html>gateway</html>", { status: 502 });
    await expect(db.query("SELECT 1")).rejects.toThrow(/^D1 query failed/);
    fake.fault = () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    await expect(db.query("SELECT 1")).rejects.toThrow(/^D1 query failed.*timed out/);
    fake.fault = () => {
      throw new TypeError("fetch failed");
    };
    await expect(db.query("SELECT 1")).rejects.toThrow(/^D1 query failed/);
  });
});

describe("createDatabase", () => {
  it("missing D1 variable is named", () => {
    const env = { CLOUDFLARE_D1_DATABASE_ID: "db", CLOUDFLARE_API_TOKEN: "t" };
    const attempt = () => createDatabase({ databasePath: ":memory:" }, env);
    expect(attempt).toThrow(DatabaseConfigError);
    expect(attempt).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(attempt).not.toThrow(/CLOUDFLARE_API_TOKEN/);
  });

  it("SQLite chosen without a D1 id", async () => {
    const db = createDatabase({ databasePath: ":memory:" }, { CLOUDFLARE_D1_DATABASE_ID: " " });
    expect(db).toBeInstanceOf(SqliteDatabase);
    await db.close();
  });

  it("D1 chosen with all variables", () => {
    const db = createDatabase(
      { databasePath: ":memory:" },
      {
        CLOUDFLARE_D1_DATABASE_ID: "db",
        CLOUDFLARE_API_TOKEN: "t",
        CLOUDFLARE_ACCOUNT_ID: "a",
      },
    );
    expect(db.constructor.name).toBe("D1Database");
  });
});
