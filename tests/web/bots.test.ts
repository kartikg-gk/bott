import { afterEach, describe, expect, it } from "vitest";
import { recordChat } from "../../src/bots/profiles.ts";
import { WEB_CHAT } from "../../src/store/store.ts";
import { backends } from "../support/fakeD1.ts";
import { Gate, gated, Harness, reply } from "./support.ts";

type Json = Record<string, unknown>;

describe.each(backends)("%s backend", (kind) => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("creates, lists, changes and deletes a bot", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([]));
    const { call } = h.app(gateway);
    const created = await call("/api/bots", {
      method: "POST",
      json: { name: "Ada", role: "Reads papers", color: "#112233", shape: "diamond" },
    });
    expect(created.status).toBe(201);
    const ada = (await created.json()) as Json;
    expect(ada).toMatchObject({ name: "Ada", color: "#112233", shape: "diamond", busy: false });
    expect(ada).not.toHaveProperty("nameKey");

    const listed = (await (await call("/api/bots")).json()) as Json[];
    expect(listed.map((b) => b.name)).toEqual(["Chief of Staff", "Ada"]);
    expect(listed[0]?.selected).toBe(true);

    const changed = await call(`/api/bots/${ada.id}`, {
      method: "PATCH",
      json: { name: "Ada Two", instructions: "Be brief", style: "upbeat" },
    });
    expect(await changed.json()).toMatchObject({
      name: "Ada Two",
      instructions: "Be brief",
      style: "upbeat",
    });
    expect((await call(`/api/bots/${ada.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/api/bots/${ada.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("refuses bad settings, clashing names and deleting the chief", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([]));
    const { call } = h.app(gateway);
    const bad = [
      { name: "x" },
      { name: "  ", role: "r" },
      { name: "x", role: "r", color: "red" },
      { name: "x", role: "r", other: 1 },
      { name: null, role: "r" },
    ];
    for (const json of bad)
      expect((await call("/api/bots", { method: "POST", json })).status).toBe(400);
    expect(
      (await call("/api/bots", { method: "POST", json: { name: "Bo", role: "r" } })).status,
    ).toBe(201);
    expect(
      (await call("/api/bots", { method: "POST", json: { name: "bo", role: "r" } })).status,
    ).toBe(409);
    const chief = await gateway.store.chief();
    expect((await call(`/api/bots/${chief.id}`, { method: "DELETE" })).status).toBe(409);
    const [, bo] = await gateway.store.bots();
    const renamed = await call(`/api/bots/${chief.id}`, {
      method: "PATCH",
      json: { name: bo?.name },
    });
    expect(renamed.status).toBe(409);
  });

  it("hides temporary bots, the memory extractor among them", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([]));
    const { call } = h.app(gateway);
    const hidden = await gateway.store.createBot({
      name: "Memory extractor",
      role: "x",
      temporary: true,
    });
    await recordChat(gateway.store, hidden.id, "assistant", "a private extraction");
    const chief = await gateway.store.chief();
    await recordChat(gateway.store, chief.id, "assistant", "hello");
    const names = ((await (await call("/api/bots")).json()) as Json[]).map((b) => b.name);
    expect(names).not.toContain("Memory extractor");
    expect(await (await call("/api/bots/unread-counts")).json()).toEqual({ [chief.id]: 1 });
    for (const path of ["messages", "export"]) {
      expect((await call(`/api/bots/${hidden.id}/${path}`)).status).toBe(404);
    }
    expect((await call(`/api/bots/${hidden.id}/select`, { method: "POST" })).status).toBe(404);
  });

  it("shows a bot's chat, newest 200 on the page and all of it in the export", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([]));
    const { call } = h.app(gateway);
    const chief = await gateway.store.chief();
    for (let n = 0; n < 205; n++) {
      await recordChat(gateway.store, chief.id, n % 2 ? "assistant" : "user", `line ${n}`);
    }
    const page = (await (await call(`/api/bots/${chief.id}/messages`)).json()) as Json[];
    expect(page).toHaveLength(200);
    expect(page.at(-1)).toEqual({ role: "user", text: "line 204" });
    expect((await (await call(`/api/bots/${chief.id}/export`)).json()) as Json[]).toHaveLength(205);
  });

  it("switches the main conversation to another bot only when it is quiet", async () => {
    h = new Harness(kind);
    const gate = new Gate();
    const gateway = await h.gateway(gated([reply("busy")], { 0: gate }));
    const { call } = h.app(gateway);
    const ada = await gateway.store.createBot({ name: "Ada", role: "r" });
    await call("/api/messages", { method: "POST", json: { text: "work" } });
    await gate.reached;
    expect((await call(`/api/bots/${ada.id}/select`, { method: "POST" })).status).toBe(409);
    const chief = await gateway.store.chief();
    expect(
      (await call(`/api/bots/${chief.id}`, { method: "PATCH", json: { role: "x" } })).status,
    ).toBe(409);
    gate.release();
    await gateway.dispatcher.idle();
    expect((await call(`/api/bots/${ada.id}/select`, { method: "POST" })).status).toBe(200);
    expect((await gateway.store.conversation(WEB_CHAT, gateway.actor)).bot).toBe(ada.id);
  });

  it("writes a greeting once and keeps it, without leaving the prompt in the chat", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([reply("Hi, I can help with papers.")]));
    const { call } = h.app(gateway);
    const ada = await gateway.store.createBot({ name: "Ada", role: "r" });
    const first = await (await call(`/api/bots/${ada.id}/greeting`, { method: "POST" })).json();
    expect(first).toEqual({ text: "Hi, I can help with papers." });
    const again = await (await call(`/api/bots/${ada.id}/greeting`, { method: "POST" })).json();
    expect(again).toEqual(first);
    expect(await (await call(`/api/bots/${ada.id}/messages`)).json()).toEqual([
      { role: "assistant", text: "Hi, I can help with papers." },
    ]);
  });
});
