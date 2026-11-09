import { afterEach, describe, expect, it } from "vitest";
import { textOf } from "../../src/agent/transcript.ts";
import { readMemoryConfig } from "../../src/memory/config.ts";
import { backends } from "../support/fakeD1.ts";
import { fakeEmbedder } from "../support/fakeEmbedder.ts";
import { gated, Harness, reply } from "./support.ts";

type Json = Record<string, unknown>;

describe.each(backends)("%s backend", (kind) => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("says memory is off when it is", async () => {
    h = new Harness(kind);
    const { call } = h.app(await h.gateway(gated([])));
    expect((await call("/api/memory")).status).toBe(409);
    expect((await call("/api/memory", { method: "POST", json: { text: "x" } })).status).toBe(409);
  });

  it("remembers, lists, forgets and restores facts, and recalls them before a message", async () => {
    h = new Harness(kind);
    const provider = gated([reply("noted")]);
    const config = readMemoryConfig({ enabled: true, searchFloor: 0 });
    const gateway = await h.gateway(provider, { memory: { config, embedder: fakeEmbedder() } });
    const { call } = h.app(gateway);

    const saved = await call("/api/memory", {
      method: "POST",
      json: { text: "Prefers tea over coffee" },
    });
    expect(saved.status).toBe(201);
    const { id } = (await saved.json()) as { id: number };
    const summary = (await (await call("/api/memory")).json()) as Json;
    expect(summary).toMatchObject({ bot: "Chief of Staff", episodes: 0, conflicts: 0 });
    expect((summary.facts as Json[]).map((f) => f.text)).toEqual(["Prefers tea over coffee"]);
    const found = (await (
      await call("/api/memory/search", { method: "POST", json: { text: "tea or coffee" } })
    ).json()) as Json[];
    expect(found[0]?.id).toBe(id);

    await call("/api/messages", { method: "POST", json: { text: "What drink do I like, tea?" } });
    await gateway.dispatcher.idle();
    const asked = provider.requests[0]?.messages.at(-1);
    expect(textOf(asked?.content ?? [])).toContain("Prefers tea over coffee");

    expect(await (await call(`/api/memory/${id}/forget`, { method: "POST" })).json()).toEqual({
      forget: id,
    });
    const forgotten = (await (await call("/api/memory/forgotten")).json()) as Json[];
    expect(forgotten.map((f) => f.id)).toEqual([id]);
    await call(`/api/memory/${id}/restore`, { method: "POST" });
    expect(((await (await call("/api/memory/facts")).json()) as Json[]).map((f) => f.id)).toEqual([
      id,
    ]);
    expect((await call("/api/memory/search", { method: "POST", json: { text: " " } })).status).toBe(
      400,
    );
    expect((await call("/api/memory?bot=nobody")).status).toBe(404);
  });
});
