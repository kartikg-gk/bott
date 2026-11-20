import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { botRoot } from "../../src/bots/bots.ts";
import { FolderMirror } from "../../src/bots/folders.ts";
import type { Database } from "../../src/db/database.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

const NOW = 1_800_000_000;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe.each(backends)("%s backend", (kind: Backend) => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function setup(hosted = true) {
    const { db } = database(kind);
    cleanups.push(() => db.close());
    const stateDir = mkdtempSync(join(tmpdir(), "folders-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const store = await Store.open(db, "main", { clock: () => NOW });
    const bot = await store.createBot({ name: "Ada", role: "Reads papers" });
    const mirror = new FolderMirror(store, stateDir, hosted);
    return { db, stateDir, store, bot, mirror, root: botRoot(stateDir, bot) };
  }

  const rows = (db: Database, table: string) =>
    db
      .query(`SELECT * FROM ${table} ORDER BY 1,2,3,4`)
      .then((found) => found.map((row) => Object.fromEntries(Object.entries(row))));

  it("fills a bot's folders from the stored notes and skill files", async () => {
    const { db, bot, mirror, root } = await setup();
    await db.run("INSERT INTO bot_memory VALUES('main',?,'KNOWLEDGE.md','Knows tides.',1)", [
      bot.id,
    ]);
    await db.run("INSERT INTO bot_memory VALUES('main',?,'other.txt','not a note',1)", [bot.id]);
    await db.run("INSERT INTO skill_files VALUES('main',?,'tides','SKILL.md','body','r1')", [
      bot.id,
    ]);
    await db.run("INSERT INTO skill_files VALUES('main',?,'tides','data/ports.txt','Vasco','r2')", [
      bot.id,
    ]);
    // A file the tables no longer hold is removed, with the folders it leaves empty.
    mkdirSync(join(root, "skills", "old", "deep"), { recursive: true });
    writeFileSync(join(root, "skills", "old", "deep", "gone.txt"), "x");
    await mirror.fill(bot);
    expect(readFileSync(join(root, "memory", "KNOWLEDGE.md"), "utf8")).toBe("Knows tides.");
    expect(existsSync(join(root, "memory", "other.txt"))).toBe(false);
    expect(readFileSync(join(root, "skills", "tides", "SKILL.md"), "utf8")).toBe("body");
    expect(readFileSync(join(root, "skills", "tides", "data", "ports.txt"), "utf8")).toBe("Vasco");
    expect(existsSync(join(root, "skills", "old"))).toBe(false);
  });

  it("keeps a bot's folders in the tables and drops removed skill files", async () => {
    const { db, bot, mirror, root } = await setup();
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "PREFERENCES.md"), "Metric units.");
    mkdirSync(join(root, "skills", "tides", "data"), { recursive: true });
    writeFileSync(join(root, "skills", "tides", "SKILL.md"), "body");
    writeFileSync(join(root, "skills", "tides", "data", "ports.txt"), "Panaji");
    await mirror.keep(bot);
    expect(await rows(db, "bot_memory")).toEqual([
      {
        instance: "main",
        bot: bot.id,
        file: "PREFERENCES.md",
        content: "Metric units.",
        updated: NOW,
      },
    ]);
    expect(await rows(db, "skill_files")).toEqual([
      {
        instance: "main",
        scope: bot.id,
        skill: "tides",
        path: "SKILL.md",
        content: "body",
        revision: sha("body"),
      },
      {
        instance: "main",
        scope: bot.id,
        skill: "tides",
        path: "data/ports.txt",
        content: "Panaji",
        revision: sha("Panaji"),
      },
    ]);
    rmSync(join(root, "skills", "tides", "data"), { recursive: true });
    writeFileSync(join(root, "memory", "PREFERENCES.md"), "Imperial units.");
    await mirror.keep(bot);
    expect((await rows(db, "skill_files")).map((row) => row.path)).toEqual(["SKILL.md"]);
    expect((await rows(db, "bot_memory")).map((row) => row.content)).toEqual(["Imperial units."]);
  });

  it("uses the empty scope for skills every bot shares", async () => {
    const { db, stateDir, mirror } = await setup();
    mkdirSync(join(stateDir, "skills", "tidy"), { recursive: true });
    writeFileSync(join(stateDir, "skills", "tidy", "SKILL.md"), "shared");
    await mirror.keep(null);
    expect((await rows(db, "skill_files")).map((row) => [row.scope, row.skill])).toEqual([
      ["", "tidy"],
    ]);
    rmSync(join(stateDir, "skills"), { recursive: true });
    await mirror.fill(null);
    expect(readFileSync(join(stateDir, "skills", "tidy", "SKILL.md"), "utf8")).toBe("shared");
  });

  it("refuses stored paths that would leave the skill folder", async () => {
    const { db, stateDir, bot, mirror, root } = await setup();
    await db.run("INSERT INTO skill_files VALUES('main',?,'..','x.txt','bad','r')", [bot.id]);
    await db.run("INSERT INTO skill_files VALUES('main',?,'ok','../../x.txt','bad','r')", [bot.id]);
    await mirror.fill(bot);
    expect(existsSync(join(root, "x.txt"))).toBe(false);
    expect(existsSync(join(stateDir, "x.txt"))).toBe(false);
    expect(existsSync(join(root, "skills", "ok"))).toBe(false);
  });

  it("does nothing on this machine, where the folders are kept as they are", async () => {
    const { db, bot, mirror, root } = await setup(false);
    await db.run("INSERT INTO bot_memory VALUES('main',?,'KNOWLEDGE.md','stored',1)", [bot.id]);
    mkdirSync(join(root, "skills", "mine"), { recursive: true });
    writeFileSync(join(root, "skills", "mine", "SKILL.md"), "local");
    await mirror.fill(bot);
    await mirror.keep(bot);
    expect(existsSync(join(root, "memory", "KNOWLEDGE.md"))).toBe(false);
    expect(readFileSync(join(root, "skills", "mine", "SKILL.md"), "utf8")).toBe("local");
    expect(await rows(db, "skill_files")).toEqual([]);
  });
});
