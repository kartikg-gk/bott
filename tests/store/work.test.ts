import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import { Store } from "../../src/store/store.js";
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

  const spec = (goal: string) => ({
    chat: 1,
    user: 2,
    actor: 3,
    thread: 0,
    bot: "b",
    goal,
    policy: "ask",
    followUp: true,
  });

  it("tasks list newest first and finish once", async () => {
    const { store, db } = await fresh();
    const first = await store.addTask(spec("one"));
    const second = await store.addTask(spec("two"));
    expect(second).toBeGreaterThan(first);
    expect((await store.tasks()).map((t) => t.goal)).toEqual(["two", "one"]);
    expect(await store.tasks(1)).toHaveLength(1);
    expect(await store.task(first)).toEqual({
      id: first,
      ...spec("one"),
      status: "running",
      answer: null,
    });
    expect(await store.task(999)).toBeNull();
    expect((await store.runningTasks()).map((t) => t.id)).toEqual([second, first]);

    now += 5;
    expect(await store.finishTask(first, "done", "ok")).toBe(true);
    expect(await store.task(first)).toMatchObject({ status: "done", answer: "ok" });
    expect((await store.runningTasks()).map((t) => t.id)).toEqual([second]);
    const row = (await db.query("SELECT finished,reported FROM tasks WHERE id=?", [first]))[0];
    expect(row).toEqual({ finished: now, reported: 1 });
  });

  it("finishing a finished task changes nothing", async () => {
    const { store } = await fresh();
    const id = await store.addTask(spec("x"));
    expect(await store.finishTask(id, "done", "first")).toBe(true);
    expect(await store.finishTask(id, "failed", "second")).toBe(false);
    expect(await store.task(id)).toMatchObject({ status: "done", answer: "first" });
    expect(await store.finishTask(404, "done", "none")).toBe(false);
  });

  it("one handoff per bot", async () => {
    const { store } = await fresh();
    const route = await store.conversation(1, 2);
    const first = await store.beginDelegation(route, "bot-a", "do it");
    expect(first).not.toBeNull();
    expect(await store.beginDelegation(route, "bot-a", "again")).toBeNull();
    expect(await store.beginDelegation(route, "bot-b", "other")).not.toBeNull();
    expect(await store.finishDelegation(first as number, "done", "fin")).toBe(true);
    expect(await store.beginDelegation(route, "bot-a", "later")).not.toBeNull();
  });

  it("two stores racing to begin give one winner", async () => {
    const { store, db } = await fresh();
    const other = await Store.open(db, "main", { clock, recover: false });
    const route = await store.conversation(1, 2);
    const results = await Promise.all([
      store.beginDelegation(route, "bot-a", "one"),
      other.beginDelegation(route, "bot-a", "two"),
    ]);
    expect(results.filter((id) => id !== null)).toHaveLength(1);
    const rows = await db.query("SELECT 1 FROM delegations WHERE bot='bot-a'");
    expect(rows).toHaveLength(1);
  });

  it("finishing a delegation records its answer once", async () => {
    const { store, db } = await fresh();
    const route = await store.conversation(1, 2);
    const id = (await store.beginDelegation(route, "bot-a", "t")) as number;
    now += 3;
    expect(await store.finishDelegation(id, "failed", "boom")).toBe(true);
    expect(await store.finishDelegation(id, "done", "late")).toBe(false);
    const row = (await db.query("SELECT status,answer,finished FROM delegations"))[0];
    expect(row).toEqual({ status: "failed", answer: "boom", finished: now });
  });
});
