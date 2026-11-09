import { afterEach, describe, expect, it } from "vitest";
import { WEB_CHAT } from "../../src/store/store.ts";
import { REPLAY_LIMIT } from "../../src/web/journal.ts";
import { backends } from "../support/fakeD1.ts";
import { Gate, gated, Harness, reply, toolCall } from "./support.ts";

const kinds = async (
  journal: { events(run: string, after: number): Promise<{ kind: string }[]> },
  run: string,
) => (await journal.events(run, 0)).map((e) => e.kind);

describe.each(backends)("%s backend", (kind) => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("records a run from queue to finish with its answer", async () => {
    h = new Harness(kind);
    const usage = { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 };
    const gateway = await h.gateway(gated([reply("all done", usage)]));
    const { journal } = gateway;
    const route = await journal.route(gateway.actor, null);
    const { run } = await journal.queue(route, "do it");
    expect(await journal.get(run, gateway.actor)).toMatchObject({
      status: "queued",
      finished: null,
    });
    expect(await journal.active(gateway.actor)).toHaveLength(1);

    await gateway.dispatch();
    await gateway.dispatcher.idle();

    const ended = await journal.get(run, gateway.actor);
    expect(ended).toMatchObject({ status: "completed", answer: "all done" });
    expect(ended?.finished).toEqual(expect.any(Number));
    expect(ended?.usage).toEqual({
      input: 10,
      output: 4,
      cache_read: 2,
      cache_write: 1,
      model_messages: 1,
      cost_usd: 0,
    });
    const seen = await kinds(journal, run);
    expect(seen[0]).toBe("run_queued");
    expect(seen).toContain("run_started");
    expect(seen.slice(-2)).toEqual(["run_usage", "run_finished"]);
    expect(await journal.active(gateway.actor)).toEqual([]);
    expect(await journal.recent(gateway.actor, null)).toHaveLength(1);
    expect(await journal.get(run, gateway.actor + 1)).toBeNull();
  });

  it("records tool calls a run makes", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([toolCall("Read", { path: "x.txt" }), reply("read")]));
    const route = await gateway.journal.route(gateway.actor, null);
    const { run } = await gateway.journal.queue(route, "read x");
    await gateway.dispatch();
    await gateway.dispatcher.idle();
    expect(await gateway.journal.activity(run)).toMatchObject([
      { type: "tool_started", id: "c1", tool: "Read", failed: false },
      { type: "tool_finished", id: "c1", tool: "Read" },
    ]);
  });

  it("stops a running run without delivering its answer", async () => {
    h = new Harness(kind);
    const gate = new Gate();
    const gateway = await h.gateway(gated([reply("too late")], { 0: gate }));
    const route = await gateway.journal.route(gateway.actor, null);
    const { run } = await gateway.journal.queue(route, "slow");
    await gateway.dispatch();
    await gate.reached;

    expect(await gateway.stopRun(run, gateway.actor + 1)).toBe(false);
    expect(await gateway.stopRun(run, gateway.actor)).toBe(true);
    expect(await gateway.stopRun(run, gateway.actor)).toBe(false);
    await gateway.dispatcher.idle();

    expect((await gateway.journal.get(run, gateway.actor))?.status).toBe("cancelled");
    const seen = await kinds(gateway.journal, run);
    expect(seen.filter((k) => k === "run_finished")).toHaveLength(1);
    const outbound = (await gateway.store.history(WEB_CHAT, gateway.actor)).filter(
      (m) => m.direction === "out",
    );
    expect(outbound).toEqual([]);
  });

  it("stops a queued run before it starts and runs the next", async () => {
    h = new Harness(kind);
    const gate = new Gate();
    const gateway = await h.gateway(gated([reply("first"), reply("third")], { 0: gate }));
    const route = await gateway.journal.route(gateway.actor, null);
    const first = await gateway.journal.queue(route, "one");
    await gateway.dispatch();
    await gate.reached;
    const second = await gateway.journal.queue(route, "two");
    const third = await gateway.journal.queue(route, "three");
    await gateway.dispatch();
    expect((await gateway.journal.get(second.run, gateway.actor))?.status).toBe("queued");

    expect(await gateway.stopRun(second.run, gateway.actor)).toBe(true);
    expect((await gateway.journal.get(second.run, gateway.actor))?.status).toBe("cancelled");
    gate.release();
    await gateway.dispatcher.idle();
    await gateway.dispatch();
    await gateway.dispatcher.idle();
    expect((await gateway.journal.get(first.run, gateway.actor))?.status).toBe("completed");
    expect((await gateway.journal.get(third.run, gateway.actor))?.answer).toBe("third");
  });

  it("gives each bot a thread of its own for the person", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([]));
    const ada = await gateway.store.createBot({ name: "Ada", role: "helper" });
    const bea = await gateway.store.createBot({ name: "Bea", role: "helper" });
    const first = await gateway.journal.route(gateway.actor, ada);
    const second = await gateway.journal.route(gateway.actor, bea);
    const again = await gateway.journal.route(gateway.actor, ada);
    expect([first.thread, second.thread, again.thread]).toEqual([1, 2, 1]);
    expect([first.bot, second.bot]).toEqual([ada.id, bea.id]);
    const { run } = await gateway.journal.queue(first, "hi");
    expect((await gateway.journal.get(run, gateway.actor))?.bot).toBe(ada.id);
  });

  it("keeps only the newest events of a long run", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([]));
    const route = await gateway.journal.route(gateway.actor, null);
    const { run } = await gateway.journal.queue(route, "chatty");
    for (let n = 0; n < REPLAY_LIMIT + 8; n++) {
      void gateway.journal.emit(run, "assistant_text", { text: String(n) });
    }
    await gateway.journal.emit(run, "assistant_text", { text: "last" });
    const events = await gateway.journal.events(run, 0);
    expect(events).toHaveLength(REPLAY_LIMIT);
    expect(events.at(-1)).toMatchObject({ seq: REPLAY_LIMIT + 10, data: { text: "last" } });
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
  });

  it("finishes runs that an earlier process left open", async () => {
    h = new Harness(kind);
    const db = h.database();
    const first = await h.gateway(gated([]), { db });
    const route = await first.journal.route(first.actor, null);
    const { run, inbox } = await first.journal.queue(route, "orphan");
    await db.run("UPDATE inbox SET status='uncertain' WHERE instance='main' AND id=?", [inbox]);

    const second = await h.gateway(gated([]), { db });
    const view = await second.journal.get(run, second.actor);
    expect(view).toMatchObject({ status: "uncertain" });
    expect(view?.finished).toEqual(expect.any(Number));
    expect((await second.journal.events(run, 0)).at(-1)?.kind).toBe("run_finished");
  });

  it("records approvals asked during a run, with their deadline", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(
      gated([toolCall("Write", { path: "a.txt", content: "x" }), reply("written")]),
      { policy: "ask" },
    );
    const route = await gateway.journal.route(gateway.actor, null);
    const { run } = await gateway.journal.queue(route, "write");
    await gateway.dispatch();
    let card: Record<string, unknown> | undefined;
    while (!card) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      card = (await gateway.journal.events(run, 0)).find(
        (e) => e.kind === "approval_requested",
      )?.data;
    }
    expect(card).toMatchObject({ tool: "Write", expires: expect.any(Number) });
    expect(card).not.toHaveProperty("run");
    expect(await gateway.dispatcher.decide(String(card.id), true, gateway.actor)).toBe(true);
    await gateway.dispatcher.idle();
    const resolved = (await gateway.journal.events(run, 0)).find(
      (e) => e.kind === "approval_resolved",
    );
    expect(resolved?.data).toEqual({ id: card.id, allowed: true });
  });
});
