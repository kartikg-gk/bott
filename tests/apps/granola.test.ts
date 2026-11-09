import { describe, expect, it } from "vitest";
import { AppConnections } from "../../src/apps/connections.ts";
import { MemoryAttempts, MemoryCredentials, MemoryFlows } from "../../src/apps/credentials.ts";
import { granola } from "../../src/apps/granola.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { Store } from "../../src/store/store.ts";
import { database } from "../support/fakeD1.ts";
import { fakeFetch, json, status } from "../support/fakeFetch.ts";

const NOTES = "https://public-api.granola.ai/v1/notes";
const NOTE = "not_ABCDEFGHIJKLMN";
const KEY = "grn_abcdefgh1234";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));

function account(routes: Parameters<typeof fakeFetch>[0]) {
  const fetcher = fakeFetch(routes);
  const apps = new AppRunner({
    fetch: fetcher,
    env: {},
    accessToken: async () => KEY,
    available: async () => true,
  });
  return { fetcher, apps };
}

describe("granola", () => {
  it("lists notes with only their summary fields", async () => {
    expect(APPS.granola).toBe(granola);
    const { fetcher, apps } = account({
      [`GET ${NOTES}`]: () =>
        json({ notes: [{ id: NOTE, title: "Sync", secret: "x" }], cursor: "c", hasMore: true }),
    });
    expect(parse(await apps.run("granola_list_notes", { folder_id: "f" }))).toEqual({
      items: [{ id: NOTE, title: "Sync" }],
      cursor: "c",
      hasMore: true,
    });
    expect(fetcher.seen[0]?.url.searchParams.get("page_size")).toBe("10");
    expect(fetcher.seen[0]?.url.searchParams.get("folder_id")).toBe("f");
    expect(fetcher.seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("pages a note's summary and refuses other IDs", async () => {
    const { apps } = account({
      [`GET ${NOTES}/${NOTE}`]: () =>
        json({ id: NOTE, summary_markdown: "s".repeat(1500), attendees: [] }),
      [`GET ${NOTES}/${NOTE}/transcript`]: () =>
        json({ transcript: [{ text: "x".repeat(20000) }] }),
    });
    const first = parse(await apps.run("granola_get_note", { note_id: NOTE }));
    expect(first.summary).toHaveLength(1000);
    expect(first.privateNotes).toBeNull();
    expect(first.nextOffset).toBe(1000);
    await expect(apps.run("granola_get_note", { note_id: "../x" })).rejects.toThrow(
      "Use a note ID that granola_list_notes gave back",
    );
    await expect(apps.run("granola_get_transcript", { note_id: NOTE })).rejects.toThrow(
      "ask for a smaller page_size",
    );
  });

  it("connects with an API key the service accepts", async () => {
    const { db } = database("sqlite");
    const store = await Store.open(db, "main");
    const bot = await store.createBot({ name: "Writer", role: "Drafts" });
    const fetcher = fakeFetch({
      [`GET ${NOTES}`]: (req) =>
        req.headers.get("authorization") === `Bearer ${KEY}` ? json({ notes: [] }) : status(401),
    });
    const credentials = new MemoryCredentials();
    const connections = new AppConnections({
      credentials,
      flows: new MemoryFlows(),
      attempts: new MemoryAttempts(),
      storeFor: async () => store,
      origin: "https://bott.test",
      fetch: fetcher,
      env: {},
    });
    const caller = { account: "a", session: "s" };
    expect(connections.configured("granola")).toBe(true);
    await expect(connections.connect(caller, "granola")).rejects.toMatchObject({ status: 409 });
    await expect(connections.saveKey(caller, "granola", { key: "nope" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      connections.saveKey(caller, "granola", { key: "grn_wrongkey99" }),
    ).rejects.toMatchObject({ status: 422, message: "Granola rejected that key" });
    await expect(connections.saveKey(caller, "github", { key: KEY })).rejects.toMatchObject({
      status: 404,
    });
    expect(await connections.saveKey(caller, "granola", { key: KEY })).toEqual({ connected: true });
    expect(JSON.parse((await credentials.get("a", "app", "granola")) as string)).toEqual({
      access: KEY,
      refresh: null,
      expires: null,
    });
    await connections.grant(caller, "granola", bot.id, { enabled: true });
    expect(await connections.token("a", "granola")).toBe(KEY);
    const listed = (await connections.list(caller)).find((a) => a.id === "granola");
    expect(listed).toMatchObject({ keyAuth: true, connected: true });
    for (let i = 0; i < 3; i++) await connections.saveKey(caller, "granola", { key: KEY });
    await expect(connections.saveKey(caller, "granola", { key: KEY })).rejects.toMatchObject({
      status: 429,
    });
    expect(await connections.disconnect(caller, "granola")).toEqual({
      connected: false,
      providerRevoked: false,
    });
    await db.close();
  });
});
