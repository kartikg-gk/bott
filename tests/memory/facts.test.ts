import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.ts";
import { readMemoryConfig } from "../../src/memory/config.ts";
import { FactStore, MemoryError, type Scope } from "../../src/memory/facts.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

const here: Scope = { project: "proj", owner: 1 };

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  let now = 1_800_000_000;
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function fresh(): Promise<{ facts: FactStore; db: Database }> {
    const { db } = database(kind);
    open.push(db);
    now = 1_800_000_000;
    const store = await Store.open(db, "main", { clock: () => now });
    return { facts: new FactStore(store.ctx), db };
  }

  const texts = async (facts: FactStore, statuses: string[], scope = here) =>
    (await facts.facts(scope, { statuses })).map((f) => f.text);

  it("a new fact is saved as current with the columns existing databases hold", async () => {
    const { facts, db } = await fresh();
    const id = await facts.add(here, "fact", "Invoice system runs on Postgres", {
      source: "extracted",
      confidence: 0.8,
      tags: ["project", "fact"],
      quote: "it is postgres",
    });
    expect(id).toBeTypeOf("number");
    const row = (await db.query("SELECT * FROM memory_facts WHERE id=?", [id]))[0];
    expect(row).toMatchObject({
      instance: "main",
      project: "proj",
      owner: 1,
      kind: "fact",
      text: "Invoice system runs on Postgres",
      confidence: 0.8,
      quote: "it is postgres",
      detail: null,
      source: "extracted",
      prompt_version: 1,
      status: "active",
      replaces: null,
      conflict: null,
      created: now,
      changed: now,
      indexed: 0,
      sync_errors: 0,
    });
    expect(JSON.parse(String(row?.tags))).toEqual(["project", "fact"]);
    const [fact] = await facts.facts(here);
    expect(fact).toMatchObject({ id, kind: "fact", tags: ["project", "fact"], status: "active" });
  });

  it("the same current fact is not saved twice and remembering it again is refused", async () => {
    const { facts } = await fresh();
    expect(await facts.add(here, "fact", "Same", { source: "explicit" })).not.toBeNull();
    expect(await facts.add(here, "fact", "Same", { source: "explicit" })).toBeNull();
    await expect(facts.remember(here, "Same")).rejects.toThrow("That fact is already saved");
  });

  it("long text is cut to 500 characters", async () => {
    const { facts } = await fresh();
    await facts.add(here, "fact", "x".repeat(900), { source: "explicit" });
    expect((await texts(facts, ["active"]))[0]).toHaveLength(500);
  });

  it("a sure revision supersedes the old fact and points back to it", async () => {
    const { facts } = await fresh();
    const old = (await facts.add(here, "fact", "Runs on Postgres", { source: "x" })) as number;
    const { outcome, id } = await facts.revise(old, here, "Runs on MySQL", 0.95, { source: "x" });
    expect(outcome).toBe("superseded");
    expect(await texts(facts, ["active"])).toEqual(["Runs on MySQL"]);
    expect(await texts(facts, ["superseded"])).toEqual(["Runs on Postgres"]);
    const replaced = await facts.row(id);
    expect(replaced).toMatchObject({ replaces: old, conflict: null, confidence: 0.95 });
  });

  it("an unsure revision holds both versions until the owner keeps one", async () => {
    const { facts } = await fresh();
    const old = (await facts.add(here, "fact", "Runs on Postgres", { source: "x" })) as number;
    const { outcome, id } = await facts.revise(old, here, "Runs on MySQL", 0.6, { source: "x" });
    expect(outcome).toBe("conflict");
    expect(await texts(facts, ["active"])).toEqual([]);
    const held = await facts.facts(here, { statuses: ["conflicted"] });
    expect(held.map((f) => [f.text, f.conflict])).toEqual([
      ["Runs on MySQL", old],
      ["Runs on Postgres", old],
    ]);
    await facts.keep(old, here);
    expect(await texts(facts, ["active"])).toEqual(["Runs on Postgres"]);
    expect((await facts.facts(here, { statuses: ["superseded"] }))[0]?.id).toBe(id);
    await expect(facts.keep(id, here)).rejects.toThrow("There is no memory with that number");
  });

  it("forgetting can be restored, and each only applies in its own state", async () => {
    const { facts } = await fresh();
    const id = (await facts.add(here, "fact", "Has a dog", { source: "x" })) as number;
    await expect(facts.restore(id, here)).rejects.toThrow(MemoryError);
    await facts.forget(id, here);
    expect(await texts(facts, ["retracted"])).toEqual(["Has a dog"]);
    await expect(facts.forget(id, here)).rejects.toThrow("There is no memory with that number");
    await facts.restore(id, here);
    expect(await texts(facts, ["active"])).toEqual(["Has a dog"]);
  });

  it("people and projects never touch each other's facts", async () => {
    const { facts } = await fresh();
    const id = (await facts.add(here, "fact", "Salary is private", { source: "x" })) as number;
    expect(await texts(facts, ["active"], { project: "proj", owner: 2 })).toEqual([]);
    expect(await texts(facts, ["active"], { project: "other", owner: 1 })).toEqual([]);
    await expect(facts.forget(id, { project: "proj", owner: 2 })).rejects.toThrow(MemoryError);
    await expect(
      facts.revise(id, { project: "other", owner: 1 }, "y", 1, { source: "x" }),
    ).rejects.toThrow(MemoryError);
    expect(await texts(facts, ["active"])).toEqual(["Salary is private"]);
  });

  it("a change marks the row for the index again", async () => {
    const { facts, db } = await fresh();
    const id = (await facts.add(here, "fact", "Has a dog", { source: "x" })) as number;
    await facts.markIndexed(id);
    now += 5;
    await facts.forget(id, here);
    const row = (await db.query("SELECT indexed,changed FROM memory_facts WHERE id=?", [id]))[0];
    expect(row).toMatchObject({ indexed: 0, changed: now });
  });

  it("failed index copies are counted, kept and retried", async () => {
    const { facts } = await fresh();
    const id = (await facts.add(here, "fact", "Has a dog", { source: "x" })) as number;
    for (let i = 0; i < 3; i++) await facts.markFailed(id, "TypeError");
    expect(await facts.failed(here)).toEqual([{ id, error: "TypeError" }]);
    expect(await facts.unsynced()).toEqual([]);
    expect(await facts.retry(here)).toBe(1);
    expect(await facts.failed(here)).toEqual([]);
    expect((await facts.unsynced()).map((r) => r.id)).toEqual([id]);
    await facts.markIndexed(id);
    expect(await facts.unsynced()).toEqual([]);
  });

  it("episodes keep their detail and lists filter by kind, newest first, at most 30", async () => {
    const { facts, db } = await fresh();
    const detail = { goal: "g", context: "c", approach: "a", outcome: "o" };
    const id = await facts.add(here, "episode", "Goal: g", { source: "episode", detail });
    for (let i = 0; i < 35; i++) await facts.add(here, "fact", `Fact ${i}`, { source: "x" });
    const row = (await db.query("SELECT detail FROM memory_facts WHERE id=?", [id]))[0];
    expect(JSON.parse(String(row?.detail))).toEqual(detail);
    expect((await facts.facts(here, { kind: "episode" })).map((f) => f.id)).toEqual([id]);
    const listed = await facts.facts(here, { kind: "fact" });
    expect(listed).toHaveLength(30);
    expect(listed[0]?.text).toBe("Fact 34");
  });

  it("facts from an outside extractor are found by their outside id", async () => {
    const { facts } = await fresh();
    const id = await facts.add(here, "fact", "Has a dog", { source: "extracted", external: "m1" });
    expect(await facts.byExternal("m1", here)).toBe(id);
    expect(await facts.byExternal("m1", { project: "other", owner: 1 })).toBeNull();
  });

  it("the index epoch is read from memory_index_epochs", async () => {
    const { facts, db } = await fresh();
    expect(await facts.epoch()).toBeNull();
    await db.run("INSERT INTO memory_index_epochs VALUES(?,?)", ["main", "abc"]);
    expect(await facts.epoch()).toBe("abc");
  });
});

describe("memory settings", () => {
  it("memory and extraction are off by default", () => {
    const config = readMemoryConfig(undefined);
    expect(config).toMatchObject({
      enabled: false,
      extract: false,
      searchLimit: 10,
      searchFloor: 0.3,
      tokenBudget: 2000,
      extractionSeconds: 120,
      qdrantUrl: null,
    });
  });

  it("reads the settings and refuses bad values", () => {
    expect(readMemoryConfig({ enabled: true, searchLimit: 5 })).toMatchObject({
      enabled: true,
      searchLimit: 5,
    });
    expect(() => readMemoryConfig({ searchLimit: 0 })).toThrow();
    expect(() => readMemoryConfig({ searchFloor: 2 })).toThrow();
    expect(() => readMemoryConfig({ tokenBudget: 50 })).toThrow();
  });

  it("hosted setups keep notes only", () => {
    expect(() => readMemoryConfig({ enabled: true }, { hosted: true })).toThrow(
      "Hosted setups keep notes only; switch memory off",
    );
    expect(readMemoryConfig({ enabled: false }, { hosted: true }).enabled).toBe(false);
  });
});
