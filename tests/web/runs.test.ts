import { afterEach, describe, expect, it } from "vitest";
import { backends } from "../support/fakeD1.ts";
import { Gate, gated, Harness, readEvents, reply, toolCall } from "./support.ts";

const finished = (records: Record<string, unknown>[]) =>
  records.some((r) => r.type === "run_finished");

describe.each(backends)("%s backend", (kind) => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("starts a run and reports where to follow it", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([reply("ready")]));
    const { call } = h.app(gateway);
    const created = await call("/api/runs", { method: "POST", json: { text: "go" } });
    expect(created.status).toBe(202);
    const view = (await created.json()) as { id: string; status: string };
    expect(created.headers.get("location")).toBe(`/api/runs/${view.id}`);
    expect(["queued", "running"]).toContain(view.status);

    const records = await readEvents(await call(`/api/runs/${view.id}/events`), finished);
    expect(records[0]).toMatchObject({ type: "run_queued", run: view.id, _seq: 1 });
    expect(records.at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
      answer: "ready",
    });
    expect(await (await call(`/api/runs/${view.id}`)).json()).toMatchObject({ answer: "ready" });
    expect(await (await call("/api/runs?recent=1")).json()).toHaveLength(1);
    expect(await (await call("/api/runs")).json()).toEqual([]);
  });

  it("streams the run in the same request when asked", async () => {
    h = new Harness(kind);
    const { call } = h.app(await h.gateway(gated([reply("streamed")])));
    const response = await call("/api/runs", {
      method: "POST",
      json: { text: "go" },
      headers: { accept: "text/event-stream" },
    });
    expect(response.headers.get("x-run-id")).toMatch(/^[0-9a-f]{32}$/);
    const records = await readEvents(response, finished);
    expect(records.at(-1)).toMatchObject({ answer: "streamed" });
  });

  it("replays from a cursor and says when events were dropped", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([reply("x")]));
    const { call } = h.app(gateway);
    const { id } = (await (
      await call("/api/runs", { method: "POST", json: { text: "go" } })
    ).json()) as {
      id: string;
    };
    await gateway.dispatcher.idle();
    const after = await readEvents(await call(`/api/runs/${id}/events?after=1`), finished);
    expect(after[0]?._seq).toBe(2);
    const resumed = await readEvents(
      await call(`/api/runs/${id}/events`, { headers: { "last-event-id": "2" } }),
      finished,
    );
    expect(resumed[0]?._seq).toBe(3);

    await gateway.store.ctx.db.run("DELETE FROM web_run_events WHERE run=? AND seq<=2", [id]);
    const gap = await readEvents(await call(`/api/runs/${id}/events`), finished);
    expect(gap[0]).toEqual({ type: "replay_gap", run: id, next: 3 });
    for (const bad of ["-1", "1a", "12345678901234567"]) {
      expect((await call(`/api/runs/${id}/events?after=${bad}`)).status).toBe(400);
    }
  });

  it("refuses run requests it cannot take", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([]));
    const { call } = h.app(gateway);
    const temp = await gateway.store.createBot({ name: "Temp", role: "x", temporary: true });
    const cases: [unknown, number][] = [
      [{ text: "hi", extra: 1 }, 400],
      [{ text: "/status" }, 400],
      [{ text: "hi", bot: 5 }, 400],
      [{ text: "hi", bot: "nobody" }, 404],
      [{ text: "hi", bot: temp.id }, 404],
    ];
    for (const [json, status] of cases) {
      expect((await call("/api/runs", { method: "POST", json })).status).toBe(status);
    }
  });

  it("runs on a named bot and stops through that bot's path", async () => {
    h = new Harness(kind);
    const gate = new Gate();
    const gateway = await h.gateway(gated([reply("never")], { 0: gate }));
    const { call } = h.app(gateway);
    const ada = await gateway.store.createBot({ name: "Ada", role: "helper" });
    const created = await call("/api/runs", { method: "POST", json: { text: "go", bot: ada.id } });
    const { id, bot } = (await created.json()) as { id: string; bot: string };
    expect(bot).toBe(ada.id);
    await gate.reached;
    expect(await (await call(`/api/runs?bot=${ada.id}`)).json()).toHaveLength(1);

    const chief = await gateway.store.chief();
    expect((await call(`/api/bots/${chief.id}/runs/${id}/stop`, { method: "POST" })).status).toBe(
      404,
    );
    const stopped = await call(`/api/bots/${ada.id}/runs/${id}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ status: "cancelled" });
    expect((await call(`/api/runs/${id}/stop`, { method: "POST" })).status).toBe(409);
    expect((await call("/api/runs/unknown/stop", { method: "POST" })).status).toBe(404);
  });

  it("lists a run's approvals with their deadline and its tool activity", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(
      gated([toolCall("Write", { path: "a.txt", content: "x" }), reply("ok")]),
      { policy: "ask" },
    );
    const { call } = h.app(gateway);
    const { id } = (await (
      await call("/api/runs", { method: "POST", json: { text: "w" } })
    ).json()) as {
      id: string;
    };
    let cards: Record<string, unknown>[] = [];
    while (cards.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      cards = (await (await call(`/api/approvals?run=${id}`)).json()) as Record<string, unknown>[];
    }
    expect(cards[0]).toMatchObject({ run: id, tool: "Write", expires: expect.any(Number) });
    expect(cards[0]).not.toHaveProperty("expiresAt");
    expect((await call("/api/approvals?run=unknown")).status).toBe(404);
    await call("/api/approvals", { method: "POST", json: { id: cards[0]?.id, allow: false } });
    await gateway.dispatcher.idle();
    const activity = (await (await call(`/api/runs/${id}/activity`)).json()) as unknown[];
    expect(activity).toMatchObject([{ type: "tool_started", tool: "Write" }, { failed: true }]);
  });

  it("lets a request reaching another process see, answer and stop a run's approvals", async () => {
    h = new Harness(kind);
    const db = h.database();
    const gate = new Gate();
    const running = await h.gateway(
      gated([toolCall("Write", { path: "a.txt", content: "x" }), reply("ok"), reply("never")], {
        2: gate,
      }),
      { db, policy: "ask" },
    );
    const other = h.app(await h.gateway(gated([]), { db, policy: "ask" })).call;
    const { call } = h.app(running);
    const start = async (text: string) =>
      (
        (await (await call("/api/runs", { method: "POST", json: { text } })).json()) as {
          id: string;
        }
      ).id;

    const id = await start("w");
    let cards: Record<string, unknown>[] = [];
    while (cards.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      cards = (await (await other(`/api/approvals?run=${id}`)).json()) as Record<string, unknown>[];
    }
    const [card] = cards;
    const here = (await (await call(`/api/approvals?run=${id}`)).json()) as unknown[];
    expect(card).toEqual(here[0]);
    expect(card).toMatchObject({ run: id, tool: "Write", expires: expect.any(Number) });
    expect(String(card?.preview)).toContain("a.txt");
    expect(await (await other("/api/approvals?run=elsewhere")).status).toBe(404);
    const answered = await other("/api/approvals", {
      method: "POST",
      json: { id: card?.id, allow: true },
    });
    expect(await answered.json()).toEqual({ decided: true });
    expect(await (await other("/api/approvals")).json()).toEqual([]);
    await running.dispatcher.idle();
    expect(await (await call(`/api/runs/${id}`)).json()).toMatchObject({ answer: "ok" });
    const activity = (await (await call(`/api/runs/${id}/activity`)).json()) as unknown[];
    expect(activity).toMatchObject([{ tool: "Write" }, { failed: false }]);

    const long = await start("wait");
    await gate.reached;
    const stopped = await other(`/api/runs/${long}/stop`, { method: "POST" });
    expect(await stopped.json()).toMatchObject({ status: "cancelled" });
    await running.dispatcher.idle();
    expect(running.dispatcher.running()).toBe(0);
  });

  it("keeps one person's runs from another", async () => {
    h = new Harness(kind);
    const db = h.database();
    const mine = await h.gateway(gated([reply("mine")]), { db });
    const theirs = await h.gateway(gated([]), { db, actor: 2 });
    const { id } = (await (
      await h.app(mine).call("/api/runs", { method: "POST", json: { text: "go" } })
    ).json()) as { id: string };
    const other = h.app(theirs).call;
    expect((await other(`/api/runs/${id}`)).status).toBe(404);
    expect((await other(`/api/runs/${id}/events`)).status).toBe(404);
    expect((await other(`/api/runs/${id}/stop`, { method: "POST" })).status).toBe(404);
    await mine.dispatcher.idle();
  });
});
