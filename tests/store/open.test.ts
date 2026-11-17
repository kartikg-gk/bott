import { afterEach, describe, expect, it } from "vitest";
import type { Database, Param } from "../../src/db/database.js";
import { Store } from "../../src/store/store.js";
import { type Backend, backends, database } from "../support/fakeD1.js";

const NOW = 1_800_000_000;
const DAY = 86400;

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

  const clock = () => NOW;
  const ask = (db: Database, sql: string, params: Param[] = []) => db.query(sql, params);

  it("open creates the schema and exactly one chief", async () => {
    const db = fresh();
    const first = await Store.open(db, "main", { clock });
    const second = await Store.open(db, "main", { clock });
    const bots = await ask(db, "SELECT * FROM bots WHERE instance='main'");
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({
      name: "Chief of Staff",
      name_key: "chief of staff",
      role: "The main bot for this person.",
      chief: 1,
    });
    expect(await first.chief()).toEqual({ id: bots[0]?.id, name: "Chief of Staff" });
    expect(await second.chief()).toEqual(await first.chief());
  });

  async function unfinished(db: Database): Promise<void> {
    for (const [id, status] of [
      [1, "scheduled"],
      [2, "dispatching"],
      [3, "running"],
      [4, "delivering"],
      [5, "cancelling"],
      [6, "completed"],
    ] as const) {
      await db.run("INSERT INTO inbox(instance,id,status,created) VALUES ('main',?,?,1)", [
        id,
        status,
      ]);
    }
    await db.run(
      "INSERT INTO tasks(instance,chat,user,actor,thread,bot,goal,policy,follow_up,status,created) " +
        "VALUES ('main',1,1,1,0,'b','g','p',0,'running',1)",
    );
    await db.run(
      "INSERT INTO delegations(instance,route,bot,task,status,created) " +
        "VALUES ('main',1,'b','t','running',1)",
    );
    await db.run(
      "INSERT INTO jobs(instance,chat,user,actor,thread,bot,task,spec,running,last_run,created) " +
        "VALUES ('main',1,1,1,0,'b','t','s',1,5,1)",
    );
    await db.run(
      "INSERT INTO job_wakeups(instance,actor,job,event,delivery,received,claimed,status) " +
        "VALUES ('main',1,1,'e','d',1,5,'running')",
    );
    await db.run("INSERT INTO approvals(instance,id,created) VALUES ('main','open',1)");
    await db.run(
      "INSERT INTO approvals(instance,id,created,decision,source) " +
        "VALUES ('main','done',1,'allowed','web')",
    );
  }

  async function state(db: Database) {
    return {
      inbox: (await ask(db, "SELECT id,status FROM inbox ORDER BY id")).map((r) => r.status),
      task: (await ask(db, "SELECT status,finished FROM tasks"))[0],
      delegation: (await ask(db, "SELECT status,finished FROM delegations"))[0],
      job: (await ask(db, "SELECT running,last_status FROM jobs"))[0],
      wakeup: (await ask(db, "SELECT status FROM job_wakeups"))[0],
      approvals: await ask(db, "SELECT id,decision,source FROM approvals ORDER BY id"),
    };
  }

  it("recovery settles unfinished work only when asked", async () => {
    const db = fresh();
    await Store.open(db, "main", { clock });
    await unfinished(db);
    const before = await state(db);

    await Store.open(db, "main", { clock, recover: false });
    expect(await state(db)).toEqual(before);

    await Store.open(db, "main", { clock, recover: true });
    expect(await state(db)).toEqual({
      inbox: ["pending", "uncertain", "uncertain", "uncertain", "uncertain", "completed"],
      task: { status: "interrupted", finished: NOW },
      delegation: { status: "interrupted", finished: NOW },
      job: { running: 0, last_status: "interrupted" },
      wakeup: { status: "interrupted" },
      approvals: [
        { id: "done", decision: "allowed", source: "web" },
        { id: "open", decision: "denied", source: "restart" },
      ],
    });
  });

  it("opening with defaults leaves running work alone", async () => {
    const db = fresh();
    await Store.open(db, "main", { clock });
    await unfinished(db);
    const before = await state(db);
    const store = await Store.open(db, "main", { clock });
    expect(await state(db)).toEqual(before);
    expect(before.task).toEqual({ status: "running", finished: null });

    await store.recover();
    expect((await state(db)).task).toEqual({ status: "interrupted", finished: NOW });
  });

  it("recovery leaves jobs alone while a scheduler lease is live", async () => {
    const db = fresh();
    await Store.open(db, "main", { clock });
    await unfinished(db);
    await db.run(
      "INSERT INTO scheduler_leases(instance,owner,heartbeat,expires) VALUES ('main','o',?,?)",
      [NOW, NOW + 60],
    );
    await Store.open(db, "main", { clock, recover: true });
    const after = await state(db);
    expect(after.job).toEqual({ running: 1, last_status: null });
    expect(after.wakeup).toEqual({ status: "running" });
  });

  it("retain removes old finished rows and keeps pending ones", async () => {
    const db = fresh();
    const store = await Store.open(db, "main", { clock, retentionDays: 7 });
    const old = NOW - 10 * DAY;
    for (const [id, status, created] of [
      [1, "completed", old],
      [2, "pending", old],
      [3, "completed", NOW],
    ] as const) {
      await db.run(
        "INSERT INTO inbox(instance,id,status,text,created) VALUES ('main',?,?,'hi',?)",
        [id, status, created],
      );
    }
    await db.run(
      "INSERT INTO web_runs(instance,id,inbox,bot,actor,finished) VALUES ('main','r1',1,'b',1,?)",
      [old],
    );
    await db.run("INSERT INTO web_runs(instance,id,inbox,bot,actor) VALUES ('main','r2',2,'b',1)");
    await db.run(
      "INSERT INTO messages(instance,route,direction,created) VALUES ('main',1,'in',?)",
      [old],
    );
    await db.run(
      "INSERT INTO approvals(instance,id,created,decision) VALUES ('main','a1',?,'allowed')",
      [NOW - 40 * DAY],
    );
    await db.run("INSERT INTO approvals(instance,id,created) VALUES ('main','a2',?)", [
      NOW - 40 * DAY,
    ]);

    expect(await store.retain()).toBe(4);
    expect((await ask(db, "SELECT id,text FROM inbox ORDER BY id")).map((r) => r.text)).toEqual([
      null,
      "hi",
      "hi",
    ]);
    expect((await ask(db, "SELECT id FROM web_runs")).map((r) => r.id)).toEqual(["r2"]);
    expect(await ask(db, "SELECT id FROM messages")).toEqual([]);
    expect((await ask(db, "SELECT id FROM approvals")).map((r) => r.id)).toEqual(["a2"]);
    expect(await store.retain()).toBe(0);
  });

  it("retain does nothing without a retention period", async () => {
    const store = await Store.open(fresh(), "main", { clock });
    expect(await store.retain()).toBe(0);
  });
});
