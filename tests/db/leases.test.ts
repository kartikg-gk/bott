import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import { Lease } from "../../src/db/leases.js";
import { ensureSchema } from "../../src/db/schema.js";
import { type Backend, backends, database } from "../support/fakeD1.js";

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const fresh = async () => {
    const { db } = database(kind);
    open.push(db);
    await ensureSchema(db);
    return db;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  it("second holder refused while lease is live", async () => {
    const db = await fresh();
    const first = new Lease(db, "bot-1", { ttlSeconds: 60, clock: () => 1_000_000 });
    const second = new Lease(db, "bot-1", { ttlSeconds: 60, clock: () => 1_030_000 });
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    await first.release();
    expect(await second.acquire()).toBe(true);
    await second.release();
  });

  it("lease taken over after expiry", async () => {
    const db = await fresh();
    const first = new Lease(db, "bot-1", { ttlSeconds: 60, clock: () => 1_000_000 });
    const second = new Lease(db, "bot-1", { ttlSeconds: 60, clock: () => 1_061_000 });
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(true);
    const rows = await db.query("SELECT owner FROM leases WHERE name = 'bot-1'");
    expect(rows).toEqual([{ owner: second.owner }]);
  });

  it("renew fails after takeover", async () => {
    const db = await fresh();
    const first = new Lease(db, "bot-1", { ttlSeconds: 60, clock: () => 1_000_000 });
    const second = new Lease(db, "bot-1", { ttlSeconds: 60, clock: () => 1_061_000 });
    await first.acquire();
    expect(await first.renew()).toBe(true);
    await second.acquire();
    expect(await first.renew()).toBe(false);
    await first.release();
    const rows = await db.query("SELECT owner FROM leases WHERE name = 'bot-1'");
    expect(rows).toEqual([{ owner: second.owner }]);
  });
});
