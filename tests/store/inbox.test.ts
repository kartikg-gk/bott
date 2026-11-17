import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import { REPORT_IDS, WEB_IDS } from "../../src/store/inbox.js";
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

  async function addTask(db: Database, chat: number, user: number, actor: number, thread = 0) {
    const rows = await db.query(
      "INSERT INTO tasks(instance,chat,user,actor,thread,bot,goal,policy,follow_up,status,created) " +
        "VALUES ('main',?,?,?,?,'b','g','p',0,'interrupted',1) RETURNING id",
      [chat, user, actor, thread],
    );
    return Number(rows[0]?.id);
  }

  it("web ids above 2^59 round trip exactly", async () => {
    const { store } = await fresh();
    const first = await store.admitWeb(1, 2, "hello");
    const second = await store.admitWeb(1, 2, "again");
    expect(typeof first.id).toBe("bigint");
    expect(first.id).toBe(WEB_IDS + 1n);
    expect(second.id).toBe(first.id + 1n);
    expect(first).toMatchObject({
      chat: 1,
      user: 2,
      actor: 2,
      thread: 0,
      text: "hello",
      status: "pending",
      run: null,
    });
    const listed = await store.pending();
    expect(listed.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(listed[0]).toEqual(first);
    expect(await store.isPending(second)).toBe(true);
  });

  it("a web admit logs the message and records its run", async () => {
    const { store, db } = await fresh();
    const route = await store.conversation(1, 2, 4);
    const item = await store.admitWeb(1, 2, "hi", { route, run: "r1" });
    expect(item).toMatchObject({ thread: 4, run: "r1", status: "pending" });
    const runs = await db.query("SELECT CAST(inbox AS TEXT) AS inbox,bot,actor FROM web_runs");
    expect(runs).toEqual([{ inbox: String(item.id), bot: route.bot, actor: 2 }]);
    const events = await db.query("SELECT seq,kind,data FROM web_run_events WHERE run='r1'");
    expect(events).toEqual([
      { seq: 1, kind: "run_queued", data: JSON.stringify({ bot: route.bot }) },
    ]);
    const logged = await db.query("SELECT route,direction,text,platform_id FROM messages");
    expect(logged).toEqual([
      { route: route.id, direction: "inbound", text: "hi", platform_id: `web-${item.id}` },
    ]);
  });

  it("mark refuses a row that changed underneath", async () => {
    const { store } = await fresh();
    const item = await store.admitWeb(1, 2, "hello");
    const stale = { ...item };
    expect(await store.mark(item, "dispatching", "r1")).toBe(true);
    expect(item).toMatchObject({ status: "dispatching", run: "r1" });
    expect(await store.isPending(item)).toBe(false);
    expect(await store.mark(stale, "cancelled")).toBe(false);
    expect(await store.mark(item, "running")).toBe(true);
    expect(await store.items()).toEqual([{ ...stale, status: "running", run: "r1" }]);
    expect(await store.pending()).toEqual([]);
  });

  it("clearing a route queue cancels only its pending items", async () => {
    const { store } = await fresh();
    const route = await store.conversation(1, 2);
    const other = await store.conversation(1, 3);
    const queued = await store.admitWeb(1, 2, "one", { route });
    const busy = await store.admitWeb(1, 2, "two", { route });
    await store.mark(busy, "running", "r1");
    const elsewhere = await store.admitWeb(1, 3, "three", { route: other });
    expect(await store.clearRouteQueue(route)).toBe(1);
    expect(await store.isPending(queued)).toBe(false);
    expect((await store.items()).map((item) => [item.id, item.status])).toEqual([
      [busy.id, "running"],
      [elsewhere.id, "pending"],
    ]);
    expect(await store.clearRouteQueue(route)).toBe(0);
  });

  it("replacing a prompt requeues the item with the new text", async () => {
    const { store } = await fresh();
    const item = await store.admitWeb(1, 2, "/queue later");
    await store.mark(item, "dispatching");
    await store.replacePrompt(item, "later");
    expect(await store.pending()).toEqual([{ ...item, text: "later", status: "pending" }]);
  });

  it("finishing a run marks only that run's items", async () => {
    const { store } = await fresh();
    const mine = await store.admitWeb(1, 2, "a");
    const queued = await store.admitWeb(1, 2, "b");
    const otherRun = await store.admitWeb(1, 2, "c");
    const otherThread = await store.admitWeb(1, 2, "d", {
      route: await store.conversation(1, 2, 9),
    });
    await store.mark(mine, "running", "r1");
    await store.mark(queued, "pending", "r1");
    await store.mark(otherRun, "running", "r2");
    await store.mark(otherThread, "running", "r1");
    await store.finishRun(1, 2, 0, "r1", "done");
    expect((await store.items()).map((item) => [item.id, item.status])).toEqual([
      [queued.id, "pending"],
      [otherRun.id, "running"],
      [otherThread.id, "running"],
    ]);
  });

  it("reports are claimed once", async () => {
    const { store, db } = await fresh();
    const web = await store.admitWeb(5, 2, "web");
    const first = await store.addReport(await addTask(db, 5, 2, 3, 1), "first done");
    const second = await store.addReport(await addTask(db, 6, 4, 4), "second done");
    expect(first).toBe(REPORT_IDS + 1n);
    expect(second).toBe(first + 1n);
    expect((await store.takeUnreported({ chat: 6 })).map((item) => item.id)).toEqual([second]);
    const taken = await store.takeUnreported();
    expect(taken).toEqual([
      {
        id: first,
        chat: 5,
        user: 2,
        actor: 3,
        thread: 1,
        text: "first done",
        status: "scheduled",
        run: null,
      },
    ]);
    expect(await store.takeUnreported()).toEqual([]);
    expect((await store.pending()).map((item) => item.id)).toEqual([web.id]);
    await expect(store.addReport(9999, "nobody")).rejects.toThrow("No task 9999");
  });

  it("late or repeated decisions do not change the outcome", async () => {
    const { store, db } = await fresh();
    const approval = { chat: 1, user: 2, thread: 0, run: "r1", tool: "shell", digest: "d" };
    await store.addApproval({ ...approval, id: "a1", expires: now + 60 });
    await store.addApproval({ ...approval, id: "a2", expires: now + 60 });
    expect(await db.query("SELECT id,created,decision,source FROM approvals ORDER BY id")).toEqual([
      { id: "a1", created: now, decision: null, source: null },
      { id: "a2", created: now, decision: null, source: null },
    ]);
    expect(await store.decide("a1", true, "web")).toBe("decided");
    expect(await store.decide("a1", false, "web")).toBe("already");
    now += 61;
    expect(await store.decide("a2", true, "web")).toBe("expired");
    expect(await store.decide("nope", true, "web")).toBe("missing");
    expect(await db.query("SELECT id,decision,source FROM approvals ORDER BY id")).toEqual([
      { id: "a1", decision: "allowed", source: "web" },
      { id: "a2", decision: null, source: null },
    ]);
  });
});
