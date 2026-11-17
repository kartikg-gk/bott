import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import { MAX_ACTIVE_JOBS, MISSED_GRACE, Store } from "../../src/store/store.js";
import { type Backend, backends, database } from "../support/fakeD1.js";

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  let now = 1_800_000_000;
  const clock = () => now;
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function fresh(): Promise<{ store: Store; db: Database }> {
    const { db } = database(kind);
    open.push(db);
    now = 1_800_000_000;
    return { store: await Store.open(db, "main", { clock }), db };
  }

  const job = (over: Partial<Parameters<Store["addJob"]>[0]> = {}) => ({
    chat: 1,
    user: 2,
    actor: 3,
    thread: 0,
    bot: "b",
    task: "report",
    spec: "every:3600",
    first: now - 10,
    ...over,
  });
  const hourly = (_spec: string, after: number) => after + 3600;

  it("due jobs are claimed and marked running", async () => {
    const { store } = await fresh();
    const due = await store.addJob(job());
    const later = await store.addJob(job({ first: now + 600 }));
    expect(await store.job(due)).toEqual({
      id: due,
      chat: 1,
      user: 2,
      actor: 3,
      thread: 0,
      bot: "b",
      task: "report",
      spec: "every:3600",
      nextRun: now - 10,
      missed: "run",
      status: "active",
      running: false,
      lastStatus: null,
      lastRun: null,
      lastAnswer: null,
    });
    const claimed = await store.claimDue(now);
    expect(claimed.map((j) => j.id)).toEqual([due]);
    expect(claimed[0]).toMatchObject({ running: true, lastRun: now });
    expect(await store.job(due)).toMatchObject({ running: true, lastRun: now });
    expect(await store.job(later)).toMatchObject({ running: false, lastRun: null });
    expect(await store.claimDue(now)).toEqual([]);

    now += 5;
    expect(
      await store.finishJob(due, "completed", "all good", { claimedAt: now - 5, next: now + 3600 }),
    ).toBe(true);
    expect(await store.job(due)).toMatchObject({
      running: false,
      status: "active",
      lastStatus: "completed",
      lastAnswer: "all good",
      nextRun: now + 3600,
    });
    expect(await store.claimDue(now)).toEqual([]);
  });

  it("only jobs in the given chat are claimed", async () => {
    const { store } = await fresh();
    await store.addJob(job({ chat: 7 }));
    const mine = await store.addJob(job({ chat: 8 }));
    expect((await store.claimDue(now, { chat: 8 })).map((j) => j.id)).toEqual([mine]);
  });

  it("a one-off job is done once it finishes without a next time", async () => {
    const { store } = await fresh();
    const id = await store.addJob(job({ spec: "at:once" }));
    await store.claimDue(now);
    expect(await store.finishJob(id, "completed", "x", { claimedAt: now, next: null })).toBe(true);
    expect(await store.job(id)).toMatchObject({ status: "done", nextRun: null, running: false });
    expect(await store.jobs({ actor: 3 })).toEqual([]);
    expect((await store.jobs({ actor: 3, history: true })).map((j) => j.id)).toEqual([id]);
  });

  it("two stores claim a due job once", async () => {
    const { store, db } = await fresh();
    const other = await Store.open(db, "main", { clock, recover: false });
    const ids = [await store.addJob(job({ bot: "x" })), await store.addJob(job({ bot: "y" }))];
    const [a, b] = await Promise.all([store.claimDue(now), other.claimDue(now)]);
    const all = [...a, ...b].map((j) => j.id).sort();
    expect(all).toEqual(ids.sort());
    const rows = await db.query("SELECT running,version FROM jobs ORDER BY id");
    expect(rows).toEqual([
      { running: 1, version: 1 },
      { running: 1, version: 1 },
    ]);
  });

  it("missed beyond grace runs once or skips by setting", async () => {
    const { store } = await fresh();
    const late = now - MISSED_GRACE - 1;
    const runs = await store.addJob(job({ bot: "r", first: late }));
    const skips = await store.addJob(job({ bot: "s", first: late, missed: "skip" }));
    const recent = await store.addJob(job({ bot: "t", first: now - 60, missed: "skip" }));
    const claimed = await store.claimDue(now, { next: hourly });
    expect(claimed.map((j) => j.id).sort()).toEqual([runs, recent].sort());
    expect(await store.job(skips)).toMatchObject({
      running: false,
      lastRun: null,
      lastStatus: "missed",
      lastAnswer: null,
      nextRun: now + 3600,
      status: "active",
    });
    expect(await store.claimDue(now, { next: hourly })).toEqual([]);
  });

  it("a skipped one-off job is done", async () => {
    const { store } = await fresh();
    const id = await store.addJob(job({ first: now - MISSED_GRACE - 1, missed: "skip" }));
    expect(await store.claimDue(now, { next: () => null })).toEqual([]);
    expect(await store.job(id)).toMatchObject({ status: "done", lastStatus: "missed" });
  });

  it("busy bots are skipped", async () => {
    const { store } = await fresh();
    await store.addJob(job({ bot: "busy" }));
    const free = await store.addJob(job({ bot: "free" }));
    await store.addJob(job({ bot: "free" }));
    const claimed = await store.claimDue(now, { busyBots: ["busy"] });
    expect(claimed.map((j) => j.id)).toEqual([free]);
  });

  it("paused automation claims nothing", async () => {
    const { store, db } = await fresh();
    await store.addJob(job());
    await db.run("INSERT INTO job_automation VALUES('main',0)");
    expect(await store.claimDue(now)).toEqual([]);
  });

  it("event jobs claim their oldest queued wake-up", async () => {
    const { store, db } = await fresh();
    const id = await store.addJob(job({ spec: "event:mail", first: null }));
    expect(await store.claimDue(now)).toEqual([]);
    for (const delivery of ["d1", "d2"]) {
      await db.run(
        "INSERT INTO job_wakeups(instance,actor,job,event,delivery,received) VALUES('main',3,?,?,?,?)",
        [id, "mail", delivery, now],
      );
    }
    expect((await store.claimDue(now)).map((j) => j.id)).toEqual([id]);
    const queue = "SELECT delivery,status,claimed FROM job_wakeups ORDER BY id";
    expect(await db.query(queue)).toEqual([
      { delivery: "d1", status: "running", claimed: now },
      { delivery: "d2", status: "queued", claimed: null },
    ]);
    now += 1;
    expect(await store.finishJob(id, "completed", "ok", { claimedAt: now - 1 })).toBe(true);
    const first = (await db.query(queue))[0];
    expect(first).toMatchObject({ status: "completed" });
    expect((await store.claimDue(now)).map((j) => j.id)).toEqual([id]);
  });

  it("quota holds when two adds race at the limit", async () => {
    const { store, db } = await fresh();
    const other = await Store.open(db, "main", { clock, recover: false });
    for (let i = 0; i < MAX_ACTIVE_JOBS - 1; i++) await store.addJob(job({ task: `t${i}` }));
    await store.addJob(job({ actor: 99 }));
    const results = await Promise.allSettled([store.addJob(job()), other.addJob(job())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(failed.reason.message)).toBe("There are already 50 active jobs");
    const count = await db.query("SELECT count(*) AS n FROM jobs WHERE actor=3");
    expect(count).toEqual([{ n: MAX_ACTIVE_JOBS }]);
    await expect(store.addJob(job({ missed: "later" as "run" }))).rejects.toThrow(
      "Missed jobs can be run or skipped",
    );
  });

  it("pause, edit and cancel only by the actor who owns the job", async () => {
    const { store } = await fresh();
    const id = await store.addJob(job({ first: now + 60 }));
    expect(await store.setJobPaused(id, 4, true)).toBe(false);
    expect(await store.setJobPaused(id, 3, false)).toBe(false);
    expect(await store.setJobPaused(id, 3, true)).toBe(true);
    expect(await store.job(id)).toMatchObject({ status: "paused" });
    expect(await store.setJobPaused(id, 3, false)).toBe(true);

    expect(await store.editJob(id, 4, { task: "stolen" })).toBe(false);
    expect(await store.editJob(id, 3, { bot: "c", task: "new", missed: "skip" })).toBe(true);
    expect(await store.job(id)).toMatchObject({
      bot: "c",
      task: "new",
      missed: "skip",
      spec: "every:3600",
      nextRun: now + 60,
    });
    expect(await store.editJob(id, 3, { spec: "daily:08:00", first: now + 900 })).toBe(true);
    expect(await store.job(id)).toMatchObject({ spec: "daily:08:00", nextRun: now + 900 });

    expect(await store.jobs({ actor: 4 })).toEqual([]);
    expect((await store.jobs({ bot: "c" })).map((j) => j.id)).toEqual([id]);

    expect(await store.cancelJob(id, 4)).toBe(false);
    expect(await store.cancelJob(id, 3)).toBe(true);
    expect(await store.job(id)).toMatchObject({ status: "cancelled", nextRun: null });
    expect(await store.cancelJob(id, 3)).toBe(false);
    expect(await store.setJobPaused(id, 3, true)).toBe(false);
    expect(await store.editJob(id, 3, { task: "late" })).toBe(false);

    const any = await store.addJob(job());
    expect(await store.cancelJob(any)).toBe(true);
    expect(await store.job(0)).toBeNull();
    expect(await store.job(1.5)).toBeNull();
  });

  it("a running job cannot be edited", async () => {
    const { store } = await fresh();
    const id = await store.addJob(job());
    await store.claimDue(now);
    expect(await store.editJob(id, 3, { task: "mid-run" })).toBe(false);
  });

  it("finish with a stale claimedAt changes nothing", async () => {
    const { store } = await fresh();
    const id = await store.addJob(job());
    await store.claimDue(now);
    expect(await store.finishJob(id, "completed", "old", { claimedAt: now - 100, next: 1 })).toBe(
      false,
    );
    expect(await store.job(id)).toMatchObject({
      running: true,
      lastStatus: null,
      nextRun: now - 10,
    });
    expect(await store.finishJob(id, "failed", "real", { claimedAt: now })).toBe(true);
    expect(await store.finishJob(id, "completed", "again", { claimedAt: now })).toBe(false);
    expect(await store.job(id)).toMatchObject({ lastStatus: "failed", lastAnswer: "real" });
  });

  it("a held scheduler keeps running jobs through recovery", async () => {
    const { store, db } = await fresh();
    const id = await store.addJob(job());
    expect(await store.holdScheduler("owner-a", 30)).toBe(true);
    await store.claimDue(now);
    expect(await store.holdScheduler("owner-b", 30)).toBe(false);
    await Store.open(db, "main", { clock });
    expect(await store.job(id)).toMatchObject({ running: true });

    now += 31;
    expect(await store.holdScheduler("owner-b", 30)).toBe(true);
    expect(await store.job(id)).toMatchObject({ running: false, lastStatus: "interrupted" });
    expect(await store.holdScheduler("owner-a", 30)).toBe(false);
    await store.releaseScheduler("owner-b");
    expect(await db.query("SELECT owner FROM scheduler_leases")).toEqual([]);
  });
});
