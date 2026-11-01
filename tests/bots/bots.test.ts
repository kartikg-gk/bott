import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { botRoot, systemAddition, workspaceDir } from "../../src/bots/bots.js";
import {
  profile,
  recordChat,
  rememberSession,
  savedSession,
  saveProfile,
} from "../../src/bots/profiles.js";
import type { Database } from "../../src/db/database.js";
import { Store } from "../../src/store/store.js";
import { type Backend, backends, database } from "../support/fakeD1.js";

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const folders: string[] = [];
  let now = 1_800_000_000;
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  async function fresh(): Promise<{ store: Store; db: Database }> {
    const { db } = database(kind);
    open.push(db);
    now = 1_800_000_000;
    return { store: await Store.open(db, "main", { clock: () => now }), db };
  }

  it("create find update keep and remove bots", async () => {
    const { store, db } = await fresh();
    const chief = await store.chief();
    now += 1;
    const writer = await store.createBot({ name: "  Writer ", role: " Drafts text " });
    expect(writer).toMatchObject({
      name: "Writer",
      nameKey: "writer",
      role: "Drafts text",
      instructions: "",
      chief: false,
      temporary: false,
    });
    now += 1;
    const scout = await store.createBot({
      name: "Scout",
      role: "Looks things up",
      instructions: "Be brief",
      temporary: true,
    });
    expect(scout.temporary).toBe(true);
    expect(scout.created).toBe(now);

    expect((await store.bots()).map((b) => b.name)).toEqual(["Chief of Staff", "Writer"]);
    expect((await store.bots({ temporary: true })).map((b) => b.name)).toEqual([
      "Chief of Staff",
      "Writer",
      "Scout",
    ]);
    expect((await store.bot(chief.id))?.chief).toBe(true);
    expect(await store.bot("missing")).toBeNull();
    expect((await store.findBot("WRITER"))?.id).toBe(writer.id);
    expect((await store.findBot(writer.id))?.name).toBe("Writer");
    expect(await store.findBot("nobody")).toBeNull();

    await saveProfile(store, writer.id, { voice: "calm" });
    await db.run("UPDATE bot_profiles SET greeting='Hello' WHERE bot=?", [writer.id]);
    const changed = await store.updateBot(writer.id, { instructions: "Short sentences" });
    expect(changed).toMatchObject({ role: "Drafts text", instructions: "Short sentences" });
    expect((await profile(store, writer.id)).greeting).toBeNull();
    expect((await store.updateBot(writer.id, { role: "Edits text" }))?.instructions).toBe(
      "Short sentences",
    );
    await expect(store.updateBot(writer.id, { role: "  " })).rejects.toThrow("needs a name");
    expect(await store.updateBot("missing", { role: "x" })).toBeNull();

    expect(await store.keepBot(scout.id)).toBe(true);
    expect(await store.keepBot(scout.id)).toBe(false);
    expect((await store.bot(scout.id))?.temporary).toBe(false);
    await expect(store.createBot({ name: "", role: "x" })).rejects.toThrow("needs a name");

    await store.setPlugin(scout.id, "web", true);
    await recordChat(store, scout.id, "user", "hi");
    expect(await store.removeBot(scout.id)).toBe(true);
    expect(await store.bot(scout.id)).toBeNull();
    expect(await store.pluginsFor(scout.id)).toEqual([]);
    expect(await db.query("SELECT 1 FROM bot_chat WHERE bot=?", [scout.id])).toEqual([]);
    expect(await store.removeBot(scout.id)).toBe(false);
  });

  it("duplicate names are refused case-insensitively", async () => {
    const { store } = await fresh();
    await store.createBot({ name: "Writer", role: "Drafts" });
    await expect(store.createBot({ name: " writer ", role: "Again" })).rejects.toThrow(
      "A bot named writer already exists",
    );
    await expect(store.createBot({ name: "chief of staff", role: "x" })).rejects.toThrow(
      "already exists",
    );
    await store.createBot({ name: "Quiet", role: "Hidden", temporary: true });
    await expect(store.createBot({ name: "QUIET", role: "x" })).rejects.toThrow("already exists");
    expect(await store.bots()).toHaveLength(2);
  });

  it("the chief cannot be removed", async () => {
    const { store } = await fresh();
    const chief = await store.chief();
    await expect(store.removeBot(chief.id)).rejects.toThrow("cannot be removed");
    expect((await store.bots())[0]?.id).toBe(chief.id);
  });

  it("plugins are granted per bot", async () => {
    const { store } = await fresh();
    const chief = await store.chief();
    const other = await store.createBot({ name: "Other", role: "r" });
    await store.setPlugin(chief.id, "web", true);
    await store.setPlugin(chief.id, "calendar", true);
    await store.setPlugin(chief.id, "web", true);
    await store.setPlugin(other.id, "mail", true);
    expect(await store.pluginsFor(chief.id)).toEqual(["calendar", "web"]);
    expect(await store.pluginsFor(other.id)).toEqual(["mail"]);
    await store.setPlugin(chief.id, "web", false);
    await store.setPlugin(chief.id, "unknown", false);
    expect(await store.pluginsFor(chief.id)).toEqual(["calendar"]);
  });

  it("profiles validate and round trip", async () => {
    const { store } = await fresh();
    const chief = await store.chief();
    expect(await profile(store, chief.id)).toEqual({
      style: "direct",
      voice: "",
      color: `#${chief.id.slice(0, 6)}`,
      shape: "orb",
      greeting: null,
    });
    const saved = await saveProfile(store, chief.id, {
      style: "upbeat",
      color: "#A1b2C3",
      shape: "diamond",
    });
    expect(await profile(store, chief.id)).toEqual(saved);
    expect(saved).toMatchObject({ style: "upbeat", color: "#A1b2C3", shape: "diamond", voice: "" });
    await saveProfile(store, chief.id, { voice: "Warm" });
    expect(await profile(store, chief.id)).toMatchObject({ style: "upbeat", voice: "Warm" });

    await expect(saveProfile(store, chief.id, { style: "rude" })).rejects.toThrow(
      "Pick a supported speaking style from the list",
    );
    await expect(saveProfile(store, chief.id, { style: "toString" })).rejects.toThrow(
      "supported speaking style",
    );
    await expect(saveProfile(store, chief.id, { voice: "x".repeat(2001) })).rejects.toThrow(
      "at most 2000",
    );
    await expect(saveProfile(store, chief.id, { color: "red" })).rejects.toThrow("hexadecimal");
    await expect(saveProfile(store, chief.id, { shape: "star" })).rejects.toThrow("avatar shape");
    expect(await profile(store, chief.id)).toMatchObject({ style: "upbeat", voice: "Warm" });

    expect(await savedSession(store, chief.id)).toBeNull();
    await rememberSession(store, chief.id, { sessionFile: "/s/one.jsonl" });
    await rememberSession(store, chief.id, { sessionFile: "/s/two.jsonl" });
    expect(await savedSession(store, chief.id)).toBe("/s/two.jsonl");
    await rememberSession(store, chief.id, {});
    expect(await savedSession(store, chief.id)).toBeNull();
  });

  it("bot chat is recorded", async () => {
    const { store, db } = await fresh();
    const chief = await store.chief();
    await recordChat(store, chief.id, "user", "Hello");
    await recordChat(store, chief.id, "assistant", "Hi there");
    const rows = await db.query("SELECT role,text FROM bot_chat WHERE bot=? ORDER BY id", [
      chief.id,
    ]);
    expect(rows).toEqual([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there" },
    ]);
  });

  it("the chief works in the project folder, others in their own workspace", async () => {
    const { store } = await fresh();
    const chief = (await store.bot((await store.chief()).id)) as NonNullable<
      Awaited<ReturnType<Store["bot"]>>
    >;
    const other = await store.createBot({ name: "Other", role: "r" });
    const state = join("/state");
    const project = join("/project");
    expect(workspaceDir(state, project, chief)).toBe(project);
    expect(workspaceDir(state, project, other)).toBe(join(botRoot(state, other), "workspace"));
    expect(botRoot(state, other)).toBe(join(state, "bots", other.id));

    const notes = mkdtempSync(join(tmpdir(), "notes-"));
    folders.push(notes);
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "PREFERENCES.md"), "# Preferences\nTea\n");
    writeFileSync(join(notes, "KNOWLEDGE.md"), "k".repeat(8100));
    const prompt = systemAddition(chief, notes);
    expect(prompt).toContain("You are Chief of Staff. Purpose: The main bot for this person.");
    expect(prompt).toContain("Running the team");
    expect(prompt).toContain("Ask the person about these.");
    expect(prompt).toContain("PREFERENCES.md:\n# Preferences\nTea");
    expect(prompt).toContain("[Cut short; read the file for the remainder.]");
    const plain = systemAddition({ ...other, instructions: "Be brief" });
    expect(plain).not.toContain("Running the team");
    expect(plain).toContain("Working instructions: Be brief");
  });
});
