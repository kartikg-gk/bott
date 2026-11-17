import { afterEach, describe, expect, it } from "vitest";
import type { ProviderRequest } from "../../src/agent/providers/types.ts";
import { textOf } from "../../src/agent/transcript.ts";
import { backends } from "../support/fakeD1.ts";
import { gated, Harness, reply } from "./support.ts";

const said = (req: ProviderRequest | undefined) =>
  (req?.messages ?? []).map((m) => `${m.role}:${textOf(m.content)}`);

const EARLIER = [
  { role: "user", content: "My name is Kai." },
  { role: "assistant", content: "Nice to meet you, Kai." },
];

describe.each(backends)("%s backend", (kind) => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("starts each hosted run from the earlier messages the browser sent", async () => {
    h = new Harness(kind);
    const provider = gated([reply("You are Kai."), reply("Fresh start.")]);
    const gateway = await h.gateway(provider, { hosted: true });
    const { call } = h.app(gateway);
    const first = await call("/api/runs", {
      method: "POST",
      json: { text: "What is my name?", conversation: EARLIER },
    });
    expect(first.status).toBe(202);
    await gateway.dispatcher.idle();
    expect(said(provider.requests[0])).toEqual([
      "user:My name is Kai.",
      "assistant:Nice to meet you, Kai.",
      "user:What is my name?",
    ]);
    const kept = await gateway.store.ctx.db.query("SELECT count(*) AS n FROM run_context");
    expect(Number(kept[0]?.n)).toBe(0);

    await call("/api/messages", { method: "POST", json: { text: "And now?" } });
    await gateway.dispatcher.idle();
    expect(said(provider.requests[1])).toEqual(["user:And now?"]);
  });

  it("refuses earlier messages past the limits", async () => {
    h = new Harness(kind);
    const { call } = h.app(await h.gateway(gated([]), { hosted: true }));
    const cases = [
      "not a list",
      Array(21).fill({ role: "user", content: "x" }),
      [{ role: "system", content: "x" }],
      [{ role: "user", content: "x".repeat(4001) }],
      [{ role: "user", content: "x", extra: 1 }],
    ];
    for (const conversation of cases) {
      const response = await call("/api/runs", {
        method: "POST",
        json: { text: "hi", conversation },
      });
      expect(response.status).toBe(400);
    }
  });

  it("keeps its own session on this machine and leaves nothing beside the message", async () => {
    h = new Harness(kind);
    const provider = gated([reply("one"), reply("two")]);
    const gateway = await h.gateway(provider);
    const { call } = h.app(gateway);
    await call("/api/runs", { method: "POST", json: { text: "first", conversation: EARLIER } });
    await gateway.dispatcher.idle();
    await call("/api/runs", { method: "POST", json: { text: "second" } });
    await gateway.dispatcher.idle();
    expect(said(provider.requests[1])).toEqual(["user:first", "assistant:one", "user:second"]);
    const kept = await gateway.store.ctx.db.query("SELECT count(*) AS n FROM run_context");
    expect(Number(kept[0]?.n)).toBe(0);
  });
});
