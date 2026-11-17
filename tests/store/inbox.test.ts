import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import { type InboxItem, REPORT_IDS, WEB_IDS } from "../../src/store/inbox.js";
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

  async function addTask(
    db: Database,
    chat: number,
    user: number,
    actor: number,
    opts: { thread?: number; status?: string; reported?: number } = {},
  ) {
    const rows = await db.query(
      "INSERT INTO tasks(instance,chat,user,actor,thread,bot,goal,policy,follow_up,status," +
        "reported,created) VALUES ('main',?,?,?,?,'b','g','p',0,?,?,1) RETURNING id",
      [chat, user, actor, opts.thread ?? 0, opts.status ?? "interrupted", opts.reported ?? 0],
    );
    return Number(rows[0]?.id);
  }

  const statuses = async (db: Database) =>
    (await db.query("SELECT CAST(id AS TEXT) AS id,status FROM inbox ORDER BY inbox.id")).map(
      (row) => [BigInt(String(row.id)), row.status],
    );

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
    expect(await store.items()).toEqual(listed);
    expect(await store.isPending(second)).toBe(true);
  });

  it("a web admit with a run queues a prompt, logs the message and records the run", async () => {
    const { store, db } = await fresh();
    const route = await store.conversation(1, 2, 4);
    const item = await store.admitWeb(1, 2, "/hi", { route, run: "r1" });
    expect(item).toMatchObject({ thread: 4, run: "r1", status: "prompt" });
    expect(await store.isPending(item)).toBe(true);
    const runs = await db.query("SELECT CAST(inbox AS TEXT) AS inbox,bot,actor FROM web_runs");
    expect(runs).toEqual([{ inbox: String(item.id), bot: route.bot, actor: 2 }]);
    const events = await db.query("SELECT seq,kind,data FROM web_run_events WHERE run='r1'");
    expect(events).toEqual([
      { seq: 1, kind: "run_queued", data: JSON.stringify({ bot: route.bot }) },
    ]);
    const logged = await db.query("SELECT route,direction,text,platform_id FROM messages");
    expect(logged).toEqual([
      { route: route.id, direction: "inbound", text: "/hi", platform_id: `web-${item.id}` },
    ]);
  });

  it("mark refuses a row that changed underneath", async () => {
    const { store, db } = await fresh();
    const item = await store.admitWeb(1, 2, "hello");
    const stale = { ...item };
    expect(await store.mark(item, "dispatching", "r1")).toBe(true);
    expect(item).toMatchObject({ status: "dispatching", run: "r1" });
    expect(await store.isPending(item)).toBe(false);
    expect(await store.mark(stale, "cancelled")).toBe(false);
    expect(await store.mark(item, "running")).toBe(true);
    expect(await statuses(db)).toEqual([[item.id, "running"]]);
  });

  it("dispatched items are not listed for dispatch again", async () => {
    const { store } = await fresh();
    const made: InboxItem[] = [];
    for (const text of ["a", "b", "c", "d", "e"]) made.push(await store.admitWeb(1, 2, text));
    const [scheduled, dispatching, running, delivering, waiting] = made as [
      InboxItem,
      InboxItem,
      InboxItem,
      InboxItem,
      InboxItem,
    ];
    await store.mark(scheduled, "scheduled");
    await store.mark(dispatching, "dispatching");
    await store.mark(running, "running");
    await store.mark(delivering, "delivering");
    expect((await store.items()).map((item) => item.id)).toEqual([waiting.id]);
    expect((await store.pending()).map((item) => item.id)).toEqual([waiting.id]);
  });

  it("clearing a route queue cancels only its pending items", async () => {
    const { store, db } = await fresh();
    const route = await store.conversation(1, 2);
    const queued = await store.admitWeb(1, 2, "one", { route });
    const command = await store.admitWeb(1, 2, "/stop", { route });
    const carried = await store.admitWeb(1, 2, "/queue later", { route });
    const prompt = await store.admitWeb(1, 2, "/x", { route, run: "r1" });
    const scheduled = await store.admitWeb(1, 2, "two", { route });
    await store.mark(scheduled, "scheduled");
    const busy = await store.admitWeb(1, 2, "three", { route });
    await store.mark(busy, "running", "r2");
    const otherUser = await store.admitWeb(1, 3, "four");
    const otherThread = await store.admitWeb(1, 2, "five", {
      route: await store.conversation(1, 2, 9),
    });
    expect(await store.clearRouteQueue(route)).toBe(4);
    expect(await statuses(db)).toEqual([
      [queued.id, "cancelled"],
      [command.id, "pending"],
      [carried.id, "cancelled"],
      [prompt.id, "cancelled"],
      [scheduled.id, "cancelled"],
      [busy.id, "running"],
      [otherUser.id, "pending"],
      [otherThread.id, "pending"],
    ]);
    expect(await store.clearRouteQueue(route)).toBe(0);
  });

  it("replacing a prompt requeues the item as a prompt", async () => {
    const { store } = await fresh();
    const item = await store.admitWeb(1, 2, "/queue /later");
    await store.mark(item, "dispatching");
    await store.replacePrompt(item, "/later");
    expect(await store.items()).toEqual([{ ...item, text: "/later", status: "prompt" }]);
    expect(item).toMatchObject({ text: "/later", status: "prompt" });
    // The item handed back follows the row, so the next move from "prompt" is allowed.
    expect(await store.mark(item, "dispatching")).toBe(true);
  });

  it("finishing a run marks only that run's items", async () => {
    const { store, db } = await fresh();
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
    await store.finishRun(1, 2, 0, "r1", "completed");
    expect(await statuses(db)).toEqual([
      [mine.id, "completed"],
      [queued.id, "pending"],
      [otherRun.id, "running"],
      [otherThread.id, "running"],
    ]);
  });

  it("rows written by an existing database with prompt status are dispatched", async () => {
    const { db } = database(kind);
    open.push(db);
    await Store.open(db, "main", { clock });
    for (const [id, text, status] of [
      [WEB_IDS + 5n, "/not a command", "prompt"],
      [WEB_IDS + 6n, "hello", "rejected"],
      [WEB_IDS + 7n, "busy", "running"],
      [REPORT_IDS + 3n, "report", "prompt"],
    ] as const) {
      await db.run(
        "INSERT INTO inbox(instance,id,chat,user,text,status,created,thread) " +
          "VALUES ('main',?,1,2,?,?,1,0)",
        [id, text, status],
      );
    }
    const store = await Store.open(db, "main", { clock });
    const listed = await store.items();
    expect(listed.map((item) => [item.id, item.status])).toEqual([
      [WEB_IDS + 5n, "prompt"],
      [WEB_IDS + 6n, "rejected"],
      [REPORT_IDS + 3n, "prompt"],
    ]);
    const [prompt] = listed as [InboxItem];
    expect(prompt).toMatchObject({ chat: 1, user: 2, actor: 2, text: "/not a command" });
    expect(await store.isPending(prompt)).toBe(true);
    expect(await store.mark(prompt, "dispatching")).toBe(true);
    expect((await store.admitWeb(1, 2, "next")).id).toBe(WEB_IDS + 8n);
  });

  it("interrupted task is reported once", async () => {
    const { store, db } = await fresh();
    const first = await addTask(db, 5, 2, 3, { thread: 1 });
    const other = await addTask(db, 6, 4, 4);
    await addTask(db, 5, 2, 2, { status: "running" });
    await addTask(db, 5, 2, 2, { reported: 1 });
    expect(await store.takeUnreported({ chat: 6 })).toEqual([
      expect.objectContaining({ task: other, chat: 6 }),
    ]);
    expect(await store.takeUnreported()).toEqual([
      {
        task: first,
        chat: 5,
        user: 2,
        actor: 3,
        thread: 1,
        text: `Task #${first} was interrupted and not replayed.`,
      },
    ]);
    expect(await store.takeUnreported()).toEqual([]);
  });

  it("report survives a restart without duplication", async () => {
    const { db } = database(kind);
    open.push(db);
    let store = await Store.open(db, "main", { clock });
    const web = await store.admitWeb(5, 2, "web");
    const task = await addTask(db, 5, 2, 3, { thread: 1, status: "running" });
    const report = await store.addReport(task, "Task done");
    expect(report).toBe(REPORT_IDS + 1n);
    expect(await store.addReport(await addTask(db, 6, 4, 4), "second")).toBe(report + 1n);
    await expect(store.addReport(9999, "nobody")).rejects.toThrow("No task 9999");

    store = await Store.open(db, "main", { clock, recover: true });
    const listed = await store.items();
    expect(listed.map((item) => item.id)).toEqual([web.id, report, report + 1n]);
    expect(listed[1]).toEqual({
      id: report,
      chat: 5,
      user: 2,
      actor: 3,
      thread: 1,
      text: "Task done",
      status: "prompt",
      run: null,
    });
    expect(await store.takeUnreported()).toEqual([]);

    expect(await store.mark(listed[1] as InboxItem, "dispatching")).toBe(true);
    store = await Store.open(db, "main", { clock, recover: true });
    expect((await store.items()).map((item) => item.id)).toEqual([web.id, report + 1n]);
    expect(await store.takeUnreported()).toEqual([]);
  });

  it("retain clears text of completed items past the period", async () => {
    const { db } = database(kind);
    open.push(db);
    now = 1_800_000_000;
    const store = await Store.open(db, "main", { clock, retentionDays: 7 });
    const done = await store.admitWeb(1, 2, "secret");
    const waiting = await store.admitWeb(1, 2, "still queued");
    await store.mark(done, "completed");
    now += 8 * 86400;
    await store.retain();
    const rows = await db.query("SELECT CAST(id AS TEXT) AS id,text FROM inbox ORDER BY inbox.id");
    expect(rows).toEqual([
      { id: String(done.id), text: null },
      { id: String(waiting.id), text: "still queued" },
    ]);
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
