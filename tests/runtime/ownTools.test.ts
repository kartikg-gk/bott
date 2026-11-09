import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider, StreamEvent } from "../../src/agent/providers/types.ts";
import { emptyUsage } from "../../src/agent/transcript.ts";
import { type Bot, botRoot } from "../../src/bots/bots.ts";
import { FolderMirror } from "../../src/bots/folders.ts";
import type { Database } from "../../src/db/database.ts";
import { answerOwnCall, OWN_TOOL_NAMES, ownTools } from "../../src/runtime/ownTools.ts";
import { type RuntimeConfig, SessionManager } from "../../src/runtime/sessions.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

function reply(text: string): StreamEvent[] {
  return [
    { type: "start", model: "m" },
    { type: "text_delta", text },
    {
      type: "end",
      entry: {
        role: "assistant",
        content: [{ type: "text", text }],
        model: "m",
        usage: emptyUsage(),
        stop: "end",
      },
    },
  ];
}

const SKILL = "---\nname: tidy-notes\ndescription: Keep notes short.\n---\nTrim each note.\n";

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const folders: string[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  async function setup(opts: { hosted?: boolean } = {}) {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main", { clock: () => 1_800_000_000 });
    const stateDir = mkdtempSync(join(tmpdir(), "own-"));
    folders.push(stateDir);
    const bot = await store.createBot({ name: "Writer", role: "Drafts text" });
    const mirrored: { file: string; text: string }[] = [];
    const ctx = {
      store,
      stateDir,
      folders: new FolderMirror(store, stateDir, opts.hosted === true),
      mirror: async (file: string, text: string) => {
        mirrored.push({ file, text });
      },
    };
    const call = async (name: string, input: unknown, who: Bot = bot) => {
      const out = await answerOwnCall({ ...ctx, bot: who }, { id: "c", name, input });
      const first = out.content[0];
      return { text: first?.type === "text" ? first.text : "", isError: out.isError === true };
    };
    return { db, store, stateDir, bot, mirrored, call };
  }

  it("asks before every change and reads notes without asking", () => {
    const flags = Object.fromEntries(ownTools().map((t) => [t.name, [t.readOnly, t.review]]));
    expect(flags).toEqual({
      update_own_bot: [false, true],
      read_memory: [true, undefined],
      write_memory: [false, true],
      write_skill: [false, true],
    });
    expect([...OWN_TOOL_NAMES].sort()).toEqual(Object.keys(flags).sort());
  });

  it("update_own_bot changes the bot's own purpose and instructions", async () => {
    const { store, bot, call } = await setup();
    const out = await call("update_own_bot", { instructions: "Write in short lines." });
    expect(out.isError).toBe(false);
    expect(await store.bot(bot.id)).toMatchObject({
      role: "Drafts text",
      instructions: "Write in short lines.",
    });
    await call("update_own_bot", { description: "Edits drafts" });
    expect((await store.bot(bot.id))?.role).toBe("Edits drafts");
  });

  it("update_own_bot refuses a blank purpose, an empty call and a removed bot", async () => {
    const { store, bot, call } = await setup();
    expect((await call("update_own_bot", { description: "  " })).isError).toBe(true);
    expect((await call("update_own_bot", {})).isError).toBe(true);
    expect((await store.bot(bot.id))?.role).toBe("Drafts text");
    const gone = { ...bot, id: "missing" };
    expect((await call("update_own_bot", { description: "x" }, gone)).text).toContain("deleted");
  });

  it("write_memory replaces a note and read_memory reads it back", async () => {
    const { stateDir, bot, mirrored, call } = await setup();
    expect(JSON.parse((await call("read_memory", { file: "KNOWLEDGE.md" })).text)).toEqual({
      file: "KNOWLEDGE.md",
      text: "",
    });
    const saved = await call("write_memory", { file: "KNOWLEDGE.md", text: "Tea, not coffee." });
    expect(saved.isError).toBe(false);
    const path = join(botRoot(stateDir, bot), "memory", "KNOWLEDGE.md");
    expect(readFileSync(path, "utf8")).toBe("Tea, not coffee.");
    expect(mirrored).toEqual([{ file: "KNOWLEDGE.md", text: "Tea, not coffee." }]);
    const read = JSON.parse((await call("read_memory", { file: "KNOWLEDGE.md" })).text);
    expect(read.text).toBe("Tea, not coffee.");
  });

  it("write_memory refuses other files and notes over 64 KB", async () => {
    const { stateDir, bot, call } = await setup();
    expect((await call("write_memory", { file: "SYSTEM.md", text: "x" })).isError).toBe(true);
    const big = await call("write_memory", { file: "PREFERENCES.md", text: "é".repeat(32_001) });
    expect(big.isError).toBe(true);
    expect(existsSync(join(botRoot(stateDir, bot), "memory", "PREFERENCES.md"))).toBe(false);
  });

  it("a hosted server keeps the notes and skills a bot writes in the database", async () => {
    const { db, call } = await setup({ hosted: true });
    await call("write_memory", { file: "PREFERENCES.md", text: "Short answers." });
    await call("write_skill", { name: "tidy-notes", files: { "SKILL.md": SKILL } });
    const notes = await db.query("SELECT file,content FROM bot_memory WHERE instance='main'");
    expect(notes).toEqual([{ file: "PREFERENCES.md", content: "Short answers." }]);
    const skills = await db.query("SELECT skill,path FROM skill_files WHERE instance='main'");
    expect(skills).toEqual([{ skill: "tidy-notes", path: "SKILL.md" }]);
  });

  it("write_skill saves a package in the bot's own skills and refuses a broken one", async () => {
    const { stateDir, bot, call } = await setup();
    const out = await call("write_skill", { name: "tidy-notes", files: { "SKILL.md": SKILL } });
    expect(out.isError).toBe(false);
    const path = join(botRoot(stateDir, bot), "skills", "tidy-notes", "SKILL.md");
    expect(readFileSync(path, "utf8")).toBe(SKILL);
    const bad = await call("write_skill", { name: "other", files: { "../x.md": "x" } });
    expect(bad.isError).toBe(true);
  });

  it("every bot is offered its own tools", async () => {
    const { store } = await setup();
    const root = mkdtempSync(join(tmpdir(), "own-run-"));
    folders.push(root);
    const config: RuntimeConfig = {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: join(root, "sessions"),
      policy: "auto",
      model: "m",
      idleSeconds: 60,
    };
    const seen: string[][] = [];
    const factory = (): ModelProvider => ({
      id: "fake",
      async *stream(req) {
        seen.push(req.tools.map((t) => t.name));
        yield* reply("ok");
      },
    });
    const sessions = new SessionManager(config, store, factory);
    try {
      const writer = (await store.findBot("Writer")) as Bot;
      await sessions.prompt(await store.conversation(1, 1), "hi");
      await sessions.prompt(await store.switchBot(await store.conversation(2, 2), writer.id), "hi");
    } finally {
      await sessions.close();
    }
    for (const tools of seen) expect(tools).toEqual(expect.arrayContaining([...OWN_TOOL_NAMES]));
  });
});
