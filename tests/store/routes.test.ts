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

  it("conversation creates one route per chat user and thread", async () => {
    const { store } = await fresh();
    const chief = await store.chief();
    const first = await store.conversation(1, 2);
    const again = await store.conversation(1, 2, 0);
    const other = await store.conversation(1, 2, 7);
    expect(again.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(first).toMatchObject({ chat: 1, user: 2, thread: 0, bot: chief.id, session: null });
    expect((await store.getRoute(first.id))?.id).toBe(first.id);
    expect(await store.getRoute(99999)).toBeNull();
  });

  it("persisting a route bumps updated and keeps the id", async () => {
    const { store } = await fresh();
    const route = await store.conversation(1, 2);
    now += 60;
    const saved = await store.persistRoute(route, {
      session: "s1",
      sessionFile: "/tmp/s1.jsonl",
      title: "First",
      model: "m",
    });
    expect(saved.id).toBe(route.id);
    expect(saved.updated).toBe(now);
    expect(saved).toMatchObject({ session: "s1", sessionFile: "/tmp/s1.jsonl", title: "First" });
    expect(saved.model).toBe("m");
    expect(await store.owns(1, 2, 0, "s1")).toBe(true);
    expect(await store.owns(1, 3, 0, "s1")).toBe(false);
    const kept = await store.persistRoute(saved, { title: "Renamed" });
    expect(kept).toMatchObject({ session: "s1", title: "Renamed", model: "m" });
  });

  it("switching bot moves the route to that bot's session", async () => {
    const { store, db } = await fresh();
    const chief = await store.chief();
    await db.run(
      "INSERT INTO bots(id,instance,name,name_key,role,created) VALUES('b2','main','Two','two','r',1)",
    );
    const route = await store.persistRoute(await store.conversation(1, 2), {
      session: "chief-session",
      sessionFile: "c.jsonl",
    });
    const moved = await store.switchBot(route, "b2");
    expect(moved).toMatchObject({ bot: "b2", session: null, sessionFile: null });
    const second = await store.persistRoute(moved, { session: "two-session" });
    const back = await store.switchBot(second, chief.id);
    expect(back).toMatchObject({ bot: chief.id, session: "chief-session", sessionFile: "c.jsonl" });
    expect((await store.switchBot(back, "b2")).session).toBe("two-session");
    await expect(store.switchBot(back, "nobody")).rejects.toThrow("Unknown bot");
  });

  it("pointing a route at another copies its bot and session", async () => {
    const { store } = await fresh();
    const source = await store.persistRoute(await store.conversation(1, 2), {
      session: "s",
      title: "T",
    });
    const target = await store.point(await store.conversation(5, 2), source);
    expect(target).toMatchObject({ session: "s", title: "T", bot: source.bot });
    expect(target.id).not.toBe(source.id);
  });

  it("saved sessions list newest first with offset", async () => {
    const { store } = await fresh();
    for (let n = 1; n <= 23; n++) {
      now += 1;
      await store.remember(1, 2, 0, { session: `s${n}`, sessionFile: `f${n}`, title: `T${n}` });
    }
    const page = await store.sessions(1, 2);
    expect(page).toHaveLength(21);
    expect(page[0]?.session).toBe("s23");
    expect(page[0]?.sessionFile).toBe("f23");
    const rest = await store.sessions(1, 2, 0, 21);
    expect(rest.map((route) => route.session)).toEqual(["s2", "s1"]);
    expect(await store.sessions(1, 2, 9)).toEqual([]);
    expect((await store.saved("s5"))?.title).toBe("T5");
    expect(await store.saved("missing")).toBeNull();
    await expect(store.remember(1, 3, 0, { session: "s5", sessionFile: null })).rejects.toThrow(
      "Unknown session owner",
    );
  });

  it("history returns logged messages oldest first, capped at limit", async () => {
    const { store } = await fresh();
    const route = await store.conversation(1, 2);
    for (const [index, direction] of (["in", "out", "in", "out"] as const).entries()) {
      now += 1;
      await store.logMessage(route, `m${index}`, direction);
    }
    const all = await store.history(1, 2);
    expect(all.map((entry) => [entry.direction, entry.text])).toEqual([
      ["in", "m0"],
      ["out", "m1"],
      ["in", "m2"],
      ["out", "m3"],
    ]);
    expect((await store.history(1, 2, 2)).map((entry) => entry.text)).toEqual(["m2", "m3"]);
  });

  it("listRoutes hides group routes when groups is false", async () => {
    const { store } = await fresh();
    const mine = await store.conversation(1, 2);
    now += 1;
    const group = await store.conversation(1, 0);
    expect((await store.listRoutes(2)).map((route) => route.id)).toEqual([group.id, mine.id]);
    expect((await store.listRoutes(2, { groups: false })).map((route) => route.id)).toEqual([
      mine.id,
    ]);
  });

  it("audit records the event with the approvals", async () => {
    const { store, db } = await fresh();
    await store.audit("approved", 1, 2, 3);
    const rows = await db.query("SELECT tool,chat,user,thread FROM approvals");
    expect(rows).toEqual([{ tool: "approved", chat: 1, user: 2, thread: 3 }]);
  });
});
