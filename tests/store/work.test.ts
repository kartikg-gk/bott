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
    expect(await store.finishTask(first, "completed", "ok")).toBe(true);
    expect(await store.task(first)).toMatchObject({ status: "completed", answer: "ok" });
    expect((await store.runningTasks()).map((t) => t.id)).toEqual([second]);
    const row = (await db.query("SELECT finished,reported FROM tasks WHERE id=?", [first]))[0];
    expect(row).toEqual({ finished: now, reported: 1 });
  });

  it("finishing a finished task changes nothing", async () => {
    const { store } = await fresh();
    const id = await store.addTask(spec("x"));
    expect(await store.finishTask(id, "completed", "first")).toBe(true);
    expect(await store.finishTask(id, "failed", "second")).toBe(false);
    expect(await store.task(id)).toMatchObject({ status: "completed", answer: "first" });
    expect(await store.finishTask(404, "completed", "none")).toBe(false);
  });

  it("one handoff per bot", async () => {
    const { store } = await fresh();
    const route = await store.conversation(1, 2);
    const first = await store.beginDelegation(route, "bot-a", "do it");
    expect(first).not.toBeNull();
    expect(await store.beginDelegation(route, "bot-a", "again")).toBeNull();
    expect(await store.beginDelegation(route, "bot-b", "other")).not.toBeNull();
    expect(await store.finishDelegation(first as number, "completed", "fin")).toBe(true);
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
    expect(await store.finishDelegation(id, "completed", "late")).toBe(false);
    const row = (await db.query("SELECT status,answer,finished FROM delegations"))[0];
    expect(row).toEqual({ status: "failed", answer: "boom", finished: now });
  });

  it("a task and a delegation can finish as timed out", async () => {
    const { store, db } = await fresh();
    const id = await store.addTask(spec("slow"));
    expect(await store.finishTask(id, "timed_out", "Task timed out")).toBe(true);
    expect(await store.task(id)).toMatchObject({ status: "timed_out", answer: "Task timed out" });
    const route = await store.conversation(1, 2);
    const delegation = (await store.beginDelegation(route, "bot-a", "slow")) as number;
    expect(await store.finishDelegation(delegation, "timed_out", "")).toBe(true);
    const row = (await db.query("SELECT status FROM delegations WHERE id=?", [delegation]))[0];
    expect(row).toEqual({ status: "timed_out" });
    expect(await store.beginDelegation(route, "bot-a", "again")).not.toBeNull();
  });

  it("existing completed tasks and delivery_failed delegations read back", async () => {
    const { store, db } = await fresh();
    const route = await store.conversation(1, 2);
    await db.run(
      "INSERT INTO tasks(instance,chat,user,actor,thread,bot,goal,policy,follow_up,status,answer,created) " +
        "VALUES('main',1,2,3,0,'b','old','ask',1,'completed','ok',1)",
    );
    await db.run(
      "INSERT INTO delegations(instance,route,bot,task,status,answer,created) " +
        "VALUES('main',?,'bot-a','old','delivery_failed','fin',1)",
      [route.id],
    );
    const [old] = await store.tasks();
    expect(old).toMatchObject({ goal: "old", status: "completed", answer: "ok" });
    expect(await store.runningTasks()).toEqual([]);
    const rows = await db.query("SELECT status FROM delegations");
    expect(rows).toEqual([{ status: "delivery_failed" }]);
    expect(await store.beginDelegation(route, "bot-a", "new")).not.toBeNull();
    const other = (await store.beginDelegation(route, "bot-b", "x")) as number;
    expect(await store.finishDelegation(other, "delivery_failed", "lost")).toBe(true);
  });
});
