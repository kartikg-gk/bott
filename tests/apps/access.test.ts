import { afterEach, describe, expect, it } from "vitest";
import { BotApps, LOAD_PLUGIN } from "../../src/apps/access.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner, toolOwner } from "../../src/apps/registry.ts";
import type { Database } from "../../src/db/database.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";
import { fakeFetch, json, offline, status } from "../support/fakeFetch.ts";
import { notes } from "../support/notesApp.ts";

describe("app tools", () => {
  it("reads need no approval, writes do, and some writes always ask", () => {
    const [read, write, send] = notes.tools;
    expect([read?.readOnly, read?.review]).toEqual([true, false]);
    expect([write?.readOnly, write?.review]).toEqual([false, false]);
    expect([send?.readOnly, send?.review]).toEqual([false, true]);
    expect(read?.input.safeParse({ id: "1", extra: 1 }).success).toBe(false);
  });

  it("every registered tool name belongs to exactly one app", () => {
    const names = Object.values(APPS).flatMap((app) => app.tools.map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(toolOwner(name)).toBeDefined();
  });
});

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function setup(runner: AppRunner) {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main", { clock: () => 1_800_000_000 });
    const bot = await store.createBot({ name: "Writer", role: "Drafts text" });
    return { store, bot, apps: new BotApps(store, runner) };
  }

  const service = () =>
    fakeFetch({
      "GET https://notes.test/notes_read/1": (req) =>
        json({ auth: req.headers.get("authorization") }),
      "GET https://notes.test/notes_read/2": () => status(500),
    });

  it("a stopped run stops the app's requests", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const watching = async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.signal);
      return json({ ok: true });
    };
    const runner = new AppRunner({ apps: { notes }, env: { NOTES_KEY: "k" }, fetch: watching });
    const { store, bot, apps } = await setup(runner);
    await store.setPlugin(bot.id, "notes", true);
    const stop = new AbortController();
    await apps.call(bot, "notes_send", { id: "1" }, stop.signal);
    expect(seen[0]?.aborted).toBe(false);
    stop.abort();
    expect(seen[0]?.aborted).toBe(true);
    const late = await apps.call(bot, "notes_send", { id: "1" }, stop.signal);
    expect(late.isError).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("a bot sees only apps granted to it and set up", async () => {
    const runner = new AppRunner({ apps: { notes }, env: {}, fetch: service() });
    const { store, bot, apps } = await setup(runner);
    expect(await apps.enabled(bot.id)).toEqual([]);
    await store.setPlugin(bot.id, "notes", true);
    await store.setPlugin(bot.id, "retired", true);
    expect(await apps.enabled(bot.id)).toEqual([]);

    const ready = new BotApps(store, new AppRunner({ apps: { notes }, env: { NOTES_KEY: "k" } }));
    expect(await ready.enabled(bot.id)).toEqual(["notes"]);
    const loader = ready.loader(["notes"]);
    expect(loader.name).toBe(LOAD_PLUGIN);
    expect(loader.readOnly).toBe(true);
    expect(loader.description).toContain("Apps you can load: notes");
  });

  it("loading gives the full tools only for an enabled app", async () => {
    const runner = new AppRunner({ apps: { notes }, env: { NOTES_KEY: "k" }, fetch: service() });
    const { store, bot, apps } = await setup(runner);
    const refused = await apps.load(bot.id, { name: "notes" });
    expect(refused.output.isError).toBe(true);
    expect(refused.tools).toEqual([]);

    await store.setPlugin(bot.id, "notes", true);
    const loaded = await apps.load(bot.id, { name: "notes" });
    expect(loaded.output.content).toEqual([
      {
        type: "text",
        text: "notes is ready. Its tools: notes_read, notes_write, notes_send.",
      },
    ]);
    expect(loaded.tools.map((t) => [t.name, t.readOnly, t.review])).toEqual([
      ["notes_read", true, false],
      ["notes_write", false, false],
      ["notes_send", false, true],
    ]);
    expect((await apps.load(bot.id, { name: 7 })).output.isError).toBe(true);
  });

  it("calls run on the server and failures come back as messages", async () => {
    const fetcher = service();
    const runner = new AppRunner({ apps: { notes }, env: { NOTES_KEY: "k" }, fetch: fetcher });
    const { store, bot, apps } = await setup(runner);
    const before = await apps.call(bot, "notes_read", { id: "1" });
    expect(before).toEqual({
      content: [{ type: "text", text: "This bot has no grant for notes." }],
      isError: true,
    });
    expect(fetcher.seen).toHaveLength(0);

    await store.setPlugin(bot.id, "notes", true);
    const out = await apps.call(bot, "notes_read", { id: "1" });
    const first = out.content[0];
    expect(first?.type === "text" && first.text.startsWith(UNTRUSTED)).toBe(true);
    expect(JSON.parse((first as { text: string }).text.slice(UNTRUSTED.length))).toEqual({
      data: { auth: "Bearer k" },
      bot: "Writer",
    });

    const failed = await apps.call(bot, "notes_read", { id: "2" });
    expect(failed.content[0]).toEqual({ type: "text", text: "notes returned HTTP 500." });
    expect((await apps.call(bot, "notes_read", {})).isError).toBe(true);
    expect((await apps.call(bot, "unknown_tool", {})).isError).toBe(true);

    const away = new BotApps(
      store,
      new AppRunner({ apps: { notes }, env: { NOTES_KEY: "k" }, fetch: offline }),
    );
    expect((await away.call(bot, "notes_read", { id: "1" })).content[0]).toEqual({
      type: "text",
      text: "notes did not answer. A change may already have been made, so do not repeat the call.",
    });
  });

  it("an app that is not set up is refused before any request", async () => {
    const fetcher = service();
    const runner = new AppRunner({ apps: { notes }, env: {}, fetch: fetcher });
    const { store, bot, apps } = await setup(runner);
    await store.setPlugin(bot.id, "notes", true);
    expect((await apps.call(bot, "notes_read", { id: "1" })).content[0]).toEqual({
      type: "text",
      text: "notes is not set up on the server.",
    });
    expect(fetcher.seen).toHaveLength(0);
  });

  it("an account's refused token is renewed once and the call retried", async () => {
    let issued = 0;
    const fetcher = fakeFetch({
      "GET https://notes.test/notes_read/1": (req) =>
        req.headers.get("authorization") === "Bearer fresh"
          ? json({ ok: true })
          : status(401, { error: "expired" }),
    });
    const renewed: string[] = [];
    const runner = new AppRunner({
      apps: { notes },
      fetch: fetcher,
      available: async () => true,
      accessToken: async () => `stale${issued++}`,
      recoverToken: async (_app, rejected) => {
        renewed.push(rejected);
        return "fresh";
      },
    });
    expect(
      JSON.parse((await runner.run("notes_read", { id: "1" })).slice(UNTRUSTED.length)),
    ).toEqual({ data: { ok: true } });
    expect(renewed).toEqual(["stale0"]);
    expect(fetcher.seen).toHaveLength(2);
  });
});
