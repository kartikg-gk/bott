import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.ts";
import { MemoryControls, projectOf } from "../../src/memory/controls.ts";
import { Memory } from "../../src/memory/memory.ts";
import { CosineIndex } from "../../src/memory/vectors.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";
import { fakeEmbedder } from "../support/fakeEmbedder.ts";

/** A private conversation; group chats have negative numbers. */
const PRIVATE = 2 ** 52;
const dirs = { stateDir: join("x", "state"), projectDir: join("x", "project") };

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function fresh(enabled = true) {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main");
    const memory = enabled ? await Memory.open(store.ctx, new CosineIndex(fakeEmbedder())) : null;
    const controls = new MemoryControls(store, memory, projectOf(dirs));
    const route = await store.conversation(PRIVATE, 11);
    return { store, memory, controls, route };
  }

  it("memory is off unless enabled", async () => {
    const { controls, route } = await fresh(false);
    await expect(controls.summary(route, 11)).rejects.toThrow(
      "Memory is not enabled on this server.",
    );
  });

  it("group chats get no personal memory", async () => {
    const { store, controls } = await fresh();
    const group = await store.conversation(-100, 11);
    await expect(controls.remember(group, 11, "x")).rejects.toThrow(
      "Memory stays off in group chats, since it is personal.",
    );
  });

  it("remember, list, forget, restore and search", async () => {
    const { controls, route } = await fresh();
    const id = await controls.remember(route, 11, "Prefers short replies");
    const summary = await controls.summary(route, 11);
    expect(summary).toMatchObject({ bot: "Chief of Staff", episodes: 0, conflicts: 0, failed: 0 });
    expect(summary.facts.map((f) => f.text)).toEqual(["Prefers short replies"]);
    await controls.forget(route, 11, id);
    expect((await controls.list(route, 11, "forgotten")).map((f) => f.id)).toEqual([id]);
    expect(await controls.search(route, 11, "short replies")).toEqual([]);
    await controls.restore(route, 11, id);
    expect((await controls.search(route, 11, "short replies")).map((f) => f.text)).toEqual([
      "Prefers short replies",
    ]);
    await expect(controls.remember(route, 11, "Prefers short replies")).rejects.toThrow(
      "That fact is already saved",
    );
    await expect(controls.remember(route, 11, "  ")).rejects.toThrow("Say what to remember");
    await expect(controls.search(route, 11, "")).rejects.toThrow("Say what to search for");
  });

  it("keep settles a conflict and the other version is superseded", async () => {
    const { controls, memory, route } = await fresh();
    const project = projectOf(dirs)({ id: "unused", chief: true });
    const scope = { project, owner: 11 };
    const old = (await memory?.facts.add(scope, "fact", "Runs on Postgres", {
      source: "explicit",
    })) as number;
    await memory?.facts.revise(old, scope, "Runs on MySQL", 0.6, { source: "extracted" });
    expect(await controls.list(route, 11, "conflicts")).toHaveLength(2);
    expect((await controls.summary(route, 11)).conflicts).toBe(2);
    await controls.keep(route, 11, old);
    expect((await controls.list(route, 11, "facts")).map((f) => f.text)).toEqual([
      "Runs on Postgres",
    ]);
    expect(await controls.list(route, 11, "conflicts")).toEqual([]);
  });

  it("another person's numbers are refused", async () => {
    const { store, controls, route } = await fresh();
    const id = await controls.remember(route, 11, "Private note");
    const other = await store.conversation(PRIVATE, 12);
    await expect(controls.forget(other, 12, id)).rejects.toThrow("There is no memory with that number");
  });

  it("memory belongs to the bot's folder, so a bot with its own folder starts empty", async () => {
    const { store, controls, route } = await fresh();
    await controls.remember(route, 11, "Uses tabs");
    const helper = await store.createBot({ name: "Helper", role: "helps" });
    const moved = await store.switchBot(route, helper.id);
    expect((await controls.summary(moved, 11)).facts).toEqual([]);
    expect(projectOf(dirs)(helper)).toBe(join("x", "state", "bots", helper.id, "workspace"));
  });

  it("retry gives failed copies another go", async () => {
    const { controls, memory, route } = await fresh();
    const index = memory?.index as CosineIndex;
    const put = index.put.bind(index);
    index.put = async () => {
      throw new Error("down");
    };
    await controls.remember(route, 11, "Uses tabs");
    for (let i = 0; i < 3; i++) await memory?.sync();
    expect((await controls.summary(route, 11)).failed).toBe(1);
    index.put = put;
    expect(await controls.retry(route, 11)).toEqual({ retried: 1, failed: 0 });
    expect(await controls.list(route, 11, "episodes")).toEqual([]);
  });
});
