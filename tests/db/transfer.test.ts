import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSchema } from "../../src/db/schema.ts";
import { SqliteDatabase } from "../../src/db/sqlite.ts";
import { checkDatabase, importLocal } from "../../src/db/transfer.ts";
import { FactStore } from "../../src/memory/facts.ts";
import { Store, WEB_CHAT } from "../../src/store/store.ts";
import { backends, database } from "../support/fakeD1.ts";

const INSTANCE = "0123456789abcdef0123456789abcdef";

describe.each(backends)("into a %s target", (kind) => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function target() {
    const { db } = database(kind);
    cleanups.push(() => db.close());
    return db;
  }

  /** A local instance with a job, a remembered fact, a lease, notes and a shared skill. */
  async function local() {
    const stateDir = mkdtempSync(join(tmpdir(), "transfer-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const source = join(stateDir, "gateway.sqlite3");
    const db = new SqliteDatabase(source);
    const store = await Store.open(db, INSTANCE);
    const chief = (await store.chief()).id;
    const route = await store.conversation(WEB_CHAT, 11);
    const job = await store.addJob({
      chat: route.chat,
      user: route.user,
      actor: 11,
      thread: route.thread,
      bot: chief,
      task: "check mail",
      spec: "every:3600",
      first: 4e9,
    });
    const facts = new FactStore(store.ctx);
    await facts.remember({ project: "p", owner: 11 }, "Prefers short answers");
    const epoch = await facts.ensureEpoch();
    await db.run("INSERT INTO leases VALUES('runner-x','someone',9e9)");
    await db.close();
    const notes = join(stateDir, "bots", chief, "memory");
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "PREFERENCES.md"), "Short answers.", "utf8");
    writeFileSync(join(notes, "other.txt"), "not a note", "utf8");
    const skill = join(stateDir, "skills", "triage", "SKILL.md");
    mkdirSync(join(stateDir, "skills", "triage"), { recursive: true });
    writeFileSync(skill, "---\nname: triage\n---\nSort incoming issues.", "utf8");
    return { stateDir, source, chief, job, epoch };
  }

  const quiet = () => {};

  it("copies the instance with its ids and owners, notes and skills, but not its leases", async () => {
    const { stateDir, source, chief, job } = await local();
    const db = target();
    await importLocal({ source, instance: INSTANCE, stateDir, target: db, out: quiet });
    const jobs = await db.query("SELECT id,instance,bot,task FROM jobs");
    expect(jobs).toEqual([{ id: job, instance: INSTANCE, bot: chief, task: "check mail" }]);
    const notes = await db.query("SELECT bot,file,content FROM bot_memory");
    expect(notes).toEqual([{ bot: chief, file: "PREFERENCES.md", content: "Short answers." }]);
    const skills = await db.query("SELECT scope,skill,path,content FROM skill_files");
    expect(skills).toEqual([
      {
        scope: "",
        skill: "triage",
        path: "SKILL.md",
        content: "---\nname: triage\n---\nSort incoming issues.",
      },
    ]);
    expect(await db.query("SELECT * FROM leases")).toEqual([]);
    const facts = await db.query("SELECT owner,text FROM memory_facts");
    expect(facts).toEqual([{ owner: 11, text: "Prefers short answers" }]);
    // The hosted store opens on the copied rows without adding a second chief.
    const store = await Store.open(db, INSTANCE);
    expect((await store.bots()).map((bot) => bot.id)).toEqual([chief]);
  });

  it("copies nothing the second time and counts what was already there", async () => {
    const { stateDir, source } = await local();
    const db = target();
    const lines: string[] = [];
    const first = await importLocal({
      source,
      instance: INSTANCE,
      stateDir,
      target: db,
      out: quiet,
    });
    expect(first.get("jobs")).toEqual({ copied: 1, there: 0 });
    expect(first.get("skill_files")).toEqual({ copied: 1, there: 0 });
    const second = await importLocal({
      source,
      instance: INSTANCE,
      stateDir,
      target: db,
      out: (line) => lines.push(line),
    });
    expect([...second.values()].every((count) => count.copied === 0)).toBe(true);
    expect(second.get("jobs")).toEqual({ copied: 0, there: 1 });
    expect(lines).toContain("jobs: 0 added, 1 present");
  });

  it("gives the hosted database its own memory index generation", async () => {
    const { stateDir, source, epoch } = await local();
    const db = target();
    await ensureSchema(db);
    await db.run("INSERT INTO memory_index_epochs VALUES(?,?)", [INSTANCE, epoch]);
    const lines: string[] = [];
    await importLocal({
      source,
      instance: INSTANCE,
      stateDir,
      target: db,
      out: (l) => lines.push(l),
    });
    const first = await db.query("SELECT epoch FROM memory_index_epochs WHERE instance=?", [
      INSTANCE,
    ]);
    expect(first).toHaveLength(1);
    expect(first[0]?.epoch).toMatch(/^[0-9a-f]{32}$/);
    expect(first[0]?.epoch).not.toBe(epoch);
    expect(lines.some((line) => line.startsWith("memory_index_epochs:"))).toBe(true);
    // Nothing new to index the second time, so the generation stays.
    await importLocal({ source, instance: INSTANCE, stateDir, target: db, out: quiet });
    const second = await db.query("SELECT epoch FROM memory_index_epochs WHERE instance=?", [
      INSTANCE,
    ]);
    expect(second[0]?.epoch).toBe(first[0]?.epoch);
  });

  it("refuses a target that already holds other bots for the instance", async () => {
    const { stateDir, source } = await local();
    const db = target();
    await Store.open(db, INSTANCE);
    await expect(
      importLocal({ source, instance: INSTANCE, stateDir, target: db, out: quiet }),
    ).rejects.toThrow(/already has bots/);
  });

  it("refuses a local file on another schema, or one without the instance", async () => {
    const { stateDir, source } = await local();
    const raw = new BetterSqlite3(source);
    raw.pragma("user_version = 3");
    raw.close();
    await expect(
      importLocal({ source, instance: INSTANCE, stateDir, target: target(), out: quiet }),
    ).rejects.toThrow(/older schema/);
    await expect(
      importLocal({
        source: join(stateDir, "missing.sqlite3"),
        instance: INSTANCE,
        stateDir,
        target: target(),
        out: quiet,
      }),
    ).rejects.toThrow(/No local database/);
  });

  it("refuses an instance the local file does not hold", async () => {
    const { stateDir, source } = await local();
    await expect(
      importLocal({ source, instance: "f".repeat(32), stateDir, target: target(), out: quiet }),
    ).rejects.toThrow(/does not hold instance/);
  });

  it("reports the backend, that it answers and its schema, changing nothing", async () => {
    const db = target();
    const lines: string[] = [];
    await checkDatabase(db, (line) => lines.push(line));
    const backend = kind === "d1" ? "D1" : "SQLite";
    expect(lines).toEqual([`${backend}: answers, no schema yet (this build expects gateway-21)`]);
    expect(await db.query("SELECT name FROM sqlite_master WHERE name='schema_migrations'")).toEqual(
      [],
    );
    await ensureSchema(db);
    lines.length = 0;
    await checkDatabase(db, (line) => lines.push(line));
    expect(lines).toEqual([
      `${backend}: answers, schema gateway-21 (this build expects gateway-21)`,
    ]);
  });
});
