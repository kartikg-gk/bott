import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import {
  automationEnabled,
  receiveWakeup,
  setAutomation,
  wakeupHistory,
} from "../../src/schedule/wakeups.js";
import { Store } from "../../src/store/store.js";
import { type Backend, backends, database } from "../support/fakeD1.js";

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const now = 1_800_000_000;
  const OWNER = "runner-owner";
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function fresh() {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main", { clock: () => now });
    await store.holdScheduler(OWNER, 86_400);
    return { db, store };
  }
  const eventJob = (spec: string, actor = 3) => ({
    chat: 1,
    user: 2,
    actor,
    thread: 0,
    bot: "b",
    task: "react",
    spec,
    first: null,
  });
  const nothing = () => null;

  it("a wake-up for an event job queues once per delivery", async () => {
    const { db, store } = await fresh();
    const id = await store.addJob(eventJob("event:deploy"));
    await store.addJob(eventJob("event:other"));
    expect(await receiveWakeup(db, "main", 3, "deploy", "d-1", now)).toBe("queued");
    expect(await receiveWakeup(db, "main", 3, "deploy", "d-1", now)).toBe("duplicate");
    expect(await receiveWakeup(db, "main", 3, "missing", "d-2", now)).toBe("unknown");
    expect(await receiveWakeup(db, "main", 4, "deploy", "d-1", now)).toBe("unknown");
    const rows = await wakeupHistory(db, "main", id);
    expect(rows).toEqual([
      {
        event: "deploy",
        delivery: "d-1",
        received: now,
        claimed: null,
        finished: null,
        status: "queued",
      },
    ]);
    const claimed = await store.claimDue(now, { owner: OWNER, next: nothing });
    expect(claimed.map((j) => j.id)).toEqual([id]);
    expect((await wakeupHistory(db, "main", id))[0]?.status).toBe("running");
  });

  it("automation off refuses wake-ups", async () => {
    const { db, store } = await fresh();
    const id = await store.addJob(eventJob("event:deploy"));
    expect(await automationEnabled(db, "main")).toBe(true);
    await setAutomation(db, "main", false);
    expect(await automationEnabled(db, "main")).toBe(false);
    expect(await receiveWakeup(db, "main", 3, "deploy", "d-1", now)).toBe("off");
    expect(await wakeupHistory(db, "main", id)).toEqual([]);
    await setAutomation(db, "main", true);
    expect(await automationEnabled(db, "main")).toBe(true);
    expect(await receiveWakeup(db, "main", 3, "deploy", "d-1", now)).toBe("queued");
  });

  it("history lists wake-ups newest first", async () => {
    const { db, store } = await fresh();
    const id = await store.addJob(eventJob("event:deploy"));
    for (const delivery of ["a", "b", "c"]) {
      await receiveWakeup(db, "main", 3, "deploy", delivery, now);
    }
    expect((await wakeupHistory(db, "main", id)).map((r) => r.delivery)).toEqual(["c", "b", "a"]);
  });

  it("bad names and delivery ids are rejected", async () => {
    const { db } = await fresh();
    await expect(receiveWakeup(db, "main", 3, "Bad Name", "d", now)).rejects.toThrow(/event name/);
    await expect(receiveWakeup(db, "main", 3, "ok", "has space", now)).rejects.toThrow(/delivery/);
  });
});
