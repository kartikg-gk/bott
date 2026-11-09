import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Policy } from "../../src/agent/policy.ts";
import type { ProviderRequest, StreamEvent } from "../../src/agent/providers/types.ts";
import { emptyUsage, textOf } from "../../src/agent/transcript.ts";
import type { Bot } from "../../src/bots/bots.ts";
import type { Database } from "../../src/db/database.ts";
import { Lease } from "../../src/db/leases.ts";
import { COULD_NOT_START, Dispatcher } from "../../src/runtime/dispatcher.ts";
import { SetupError } from "../../src/runtime/errors.ts";
import { type RuntimeConfig, SessionManager } from "../../src/runtime/sessions.ts";
import { Store, WEB_CHAT } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";
import { type FakeProvider, fakeProvider } from "../support/fakeProvider.ts";
import { MemorySink } from "../support/memorySink.ts";

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

function toolCall(name: string, input: unknown): StreamEvent[] {
  return [
    { type: "start", model: "m" },
    {
      type: "end",
      entry: {
        role: "assistant",
        content: [{ type: "call", id: "c1", name, input }],
        model: "m",
        usage: emptyUsage(),
        stop: "end",
      },
    },
  ];
}

/** Holds a model call until opened; an aborted run gets through with an error. */
class Gate {
  private open!: () => void;
  private arrive!: () => void;
  readonly opened = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  /** Resolves once a model call is waiting here. */
  readonly reached = new Promise<void>((resolve) => {
    this.arrive = resolve;
  });

  release(): void {
    this.open();
  }

  async pass(signal: AbortSignal): Promise<void> {
    this.arrive();
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      void this.opened.then(resolve);
    });
  }
}

/** Plays the script, holding the calls that have a gate (by call number) until it opens. */
function gated(script: StreamEvent[][], gates: Record<number, Gate> = {}): FakeProvider {
  const inner = fakeProvider(script);
  let calls = 0;
  return {
    id: inner.id,
    requests: inner.requests,
    async *stream(req) {
      const gate = gates[calls++];
      if (gate) await gate.pass(req.signal);
      yield* inner.stream(req);
    },
  };
}

const said = (req: ProviderRequest | undefined) =>
  (req?.messages ?? []).map((m) => textOf(m.content));

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const folders: string[] = [];
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
    await Promise.all(open.splice(0).map((db) => db.close()));
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  async function setup(
    provider: FakeProvider,
    opts: { policy?: Policy; workers?: number; clock?: () => number } = {},
  ) {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main", { clock: opts.clock ?? (() => Date.now() / 1000) });
    const root = mkdtempSync(join(tmpdir(), "dispatcher-"));
    folders.push(root);
    const config: RuntimeConfig = {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: join(root, "sessions"),
      policy: opts.policy ?? "auto",
      model: "m",
      idleSeconds: 60,
    };
    const sessions = new SessionManager(config, store, () => provider);
    managers.push(sessions);
    const sink = new MemorySink();
    const dispatcher = new Dispatcher(store, sessions, sink, {
      workers: opts.workers,
      watchMs: 20,
    });
    const status = async (id: bigint) =>
      String(
        (await db.query("SELECT status FROM inbox WHERE instance='main' AND id=?", [id]))[0]
          ?.status,
      );
    return { db, store, sessions, sink, dispatcher, status, config };
  }

  /** Another process on the same database, with sessions and a dispatcher of its own. */
  async function elsewhere(db: Database, config: RuntimeConfig) {
    const store = await Store.open(db, "main");
    const sessions = new SessionManager(config, store, () => gated([]));
    managers.push(sessions);
    const dispatcher = new Dispatcher(store, sessions, new MemorySink(), { watchMs: 20 });
    return { store, dispatcher };
  }

  it("a pending message runs and its answer is delivered", async () => {
    const provider = gated([reply("hello")]);
    const { store, sink, dispatcher, status } = await setup(provider);
    const item = await store.admitWeb(WEB_CHAT, 7, "hi");

    expect(await dispatcher.tick()).toBe(1);
    await dispatcher.idle();

    expect(sink.texts()).toEqual(["hello"]);
    expect(sink.sent[0]?.route.user).toBe(7);
    expect(sink.events.map((s) => s.e.type)).toContain("agent_settled");
    expect(await status(item.id)).toBe("completed");
    expect(await store.history(WEB_CHAT, 7)).toMatchObject([
      { direction: "in", text: "hi" },
      { direction: "out", text: "hello" },
    ]);
    expect(await dispatcher.tick()).toBe(0);
  });

  it("messages on one route run one at a time", async () => {
    const gate = new Gate();
    const provider = gated([reply("one"), reply("two")], { 0: gate });
    const { store, sink, dispatcher, status } = await setup(provider);
    const first = await store.admitWeb(WEB_CHAT, 7, "first");
    const second = await store.admitWeb(WEB_CHAT, 7, "second");

    expect(await dispatcher.tick()).toBe(1);
    await gate.reached;
    expect(await status(first.id)).toBe("running");
    expect(await dispatcher.tick()).toBe(0);
    expect(await status(second.id)).toBe("pending");

    gate.release();
    await dispatcher.idle();
    expect(await dispatcher.tick()).toBe(1);
    await dispatcher.idle();

    expect(sink.texts()).toEqual(["one", "two"]);
    expect(said(provider.requests[1])).toEqual(["first", "one", "second"]);
    expect(await status(second.id)).toBe("completed");
  });

  /** Puts the person's route on a new bot of its own. */
  async function onNewBot(store: Store, user: number, name: string): Promise<string> {
    const bot = await store.createBot({ name, role: "helper" });
    await store.switchBot(await store.conversation(WEB_CHAT, user), bot.id);
    return bot.id;
  }

  it("different routes run in parallel up to workers", async () => {
    const gates = { 0: new Gate(), 1: new Gate() };
    const provider = gated([reply("a"), reply("b"), reply("c")], gates);
    const { store, sink, dispatcher, status } = await setup(provider, { workers: 2 });
    await onNewBot(store, 1, "Ada");
    await onNewBot(store, 2, "Bea");
    await onNewBot(store, 3, "Cy");
    await store.admitWeb(WEB_CHAT, 1, "from one");
    await store.admitWeb(WEB_CHAT, 2, "from two");
    const third = await store.admitWeb(WEB_CHAT, 3, "from three");

    expect(await dispatcher.tick()).toBe(2);
    await Promise.all([gates[0].reached, gates[1].reached]);
    expect(await status(third.id)).toBe("pending");
    expect(await dispatcher.tick()).toBe(0);

    gates[0].release();
    gates[1].release();
    await dispatcher.idle();
    expect(await dispatcher.tick()).toBe(1);
    await dispatcher.idle();
    expect(sink.sent.map((s) => s.route.user).sort()).toEqual([1, 2, 3]);
    expect(await status(third.id)).toBe("completed");
  });

  it("two routes on one bot run one after the other", async () => {
    const gate = new Gate();
    const provider = gated([reply("a"), reply("b"), reply("c")], { 0: gate });
    const { db, store, sink, dispatcher, status } = await setup(provider, { workers: 2 });
    const first = await store.admitWeb(WEB_CHAT, 1, "from one");
    const second = await store.admitWeb(WEB_CHAT, 2, "from two");

    expect(await dispatcher.tick()).toBe(1);
    await gate.reached;
    expect(await status(first.id)).toBe("running");
    expect(await dispatcher.tick()).toBe(0);
    expect(await status(second.id)).toBe("pending");

    gate.release();
    await dispatcher.idle();
    expect(await dispatcher.tick()).toBe(1);
    await dispatcher.idle();
    expect(sink.texts()).toEqual(["a", "b"]);
    expect(await status(second.id)).toBe("completed");

    // Another process holding the bot leaves the message waiting, not failed.
    const chief = (await store.chief()).id;
    const elsewhere = new Lease(db, `bot-${chief}`);
    expect(await elsewhere.acquire()).toBe(true);
    const third = await store.admitWeb(WEB_CHAT, 1, "later");
    expect(await dispatcher.tick()).toBe(1);
    await dispatcher.idle();
    expect(await status(third.id)).toBe("pending");
    expect(sink.texts()).toEqual(["a", "b"]);
    await elsewhere.release();
    expect(await dispatcher.tick()).toBe(1);
    await dispatcher.idle();
    expect(await status(third.id)).toBe("completed");
    expect(sink.texts()).toEqual(["a", "b", "c"]);
  });

  it("approvals expire by the store clock", async () => {
    let now = 1_800_000_000;
    const provider = gated([
      toolCall("Write", { path: "first.txt", content: "one" }),
      reply("wrote it"),
      toolCall("Write", { path: "second.txt", content: "two" }),
      reply("did not"),
    ]);
    const { db, store, sessions, sink, dispatcher, status } = await setup(provider, {
      policy: "ask",
      clock: () => now,
    });
    const chief = (await store.bot((await store.chief()).id)) as Bot;
    const root = sessions.workspaceFor(chief).root;

    await store.admitWeb(WEB_CHAT, 7, "first");
    expect(await dispatcher.tick()).toBe(1);
    const inTime = await sink.nextCard();
    expect(inTime.expiresAt).toBe(now + 300);
    expect(dispatcher.approvals(7)).toEqual([inTime]);
    now += 299;
    expect(await dispatcher.decide(inTime.id, true, 7)).toBe(true);
    await dispatcher.idle();
    expect(readFileSync(join(root, "first.txt"), "utf8")).toBe("one");

    const late = await store.admitWeb(WEB_CHAT, 7, "second");
    expect(await dispatcher.tick()).toBe(1);
    const card = await sink.nextCard();
    expect(card.expiresAt).toBe(now + 300);
    now += 301;
    expect(dispatcher.approvals(7)).toEqual([]);
    expect(await dispatcher.decide(card.id, true, 7)).toBe(true);
    await dispatcher.idle();
    expect(existsSync(join(root, "second.txt"))).toBe(false);
    expect(await status(late.id)).toBe("completed");
    expect(sink.texts().at(-1)).toBe("did not");
    const row = (await db.query("SELECT decision FROM approvals WHERE id=?", [inTime.id]))[0];
    expect(row).toMatchObject({ decision: "allowed" });
  });

  it("a failing run frees the route and reports the error", async () => {
    const provider = gated([[{ type: "error", message: "model is down" }], reply("back")]);
    const { store, sink, dispatcher, status } = await setup(provider);
    const first = await store.admitWeb(WEB_CHAT, 7, "first");
    const second = await store.admitWeb(WEB_CHAT, 7, "second");

    expect(await dispatcher.tick()).toBe(1);
    await dispatcher.idle();
    expect(sink.texts()).toEqual(["model is down\n[Run failed]"]);
    expect(await status(first.id)).toBe("failed");

    expect(await dispatcher.tick()).toBe(1);
    await dispatcher.idle();
    expect(sink.texts().at(-1)).toBe("back");
    expect(await status(second.id)).toBe("completed");

    // A run that cannot start at all says why and is not retried.
    const route = await store.conversation(WEB_CHAT, 8);
    await store.persistRoute(route, { session: "gone", sessionFile: join(tmpdir(), "gone.jsonl") });
    const broken = await store.admitWeb(WEB_CHAT, 8, "hello?");
    expect(await dispatcher.tick()).toBe(1);
    await dispatcher.idle();
    expect(await status(broken.id)).toBe("failed");
    expect(sink.sent.at(-1)).toMatchObject({
      route: { user: 8 },
      text: expect.stringContaining("the saved session file is gone"),
    });
    expect(await dispatcher.tick()).toBe(0);
  });

  it("a run that cannot start names a setup problem and keeps other errors to itself", async () => {
    const { store, sessions, sink, dispatcher, status } = await setup(gated([]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      sessions.prompt = async () => {
        throw new SetupError(
          "No model key is saved for this account yet; add one under Account settings",
        );
      };
      const fixable = await store.admitWeb(WEB_CHAT, 9, "hi");
      await dispatcher.tick();
      await dispatcher.idle();
      expect(await status(fixable.id)).toBe("failed");
      expect(sink.texts().at(-1)).toBe(
        "No model key is saved for this account yet; add one under Account settings",
      );

      sessions.prompt = async () => {
        throw new Error("SQLITE_BUSY at C:/state/gateway.sqlite3");
      };
      const odd = await store.admitWeb(WEB_CHAT, 9, "again");
      await dispatcher.tick();
      await dispatcher.idle();
      expect(await status(odd.id)).toBe("failed");
      expect(sink.texts().at(-1)).toBe(COULD_NOT_START);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("an answer that cannot be delivered is marked delivery_failed", async () => {
    const { store, sink, dispatcher, status } = await setup(gated([reply("lost")]));
    sink.failSend = "page closed";
    const item = await store.admitWeb(WEB_CHAT, 7, "hi");
    expect(await dispatcher.tick()).toBe(1);
    await dispatcher.idle();
    expect(await status(item.id)).toBe("delivery_failed");
  });

  it("an approval card waits for a decision and the tool then runs", async () => {
    const provider = gated([
      toolCall("Write", { path: "note.txt", content: "kept" }),
      reply("done"),
    ]);
    const { db, store, sessions, sink, dispatcher, status } = await setup(provider, {
      policy: "ask",
    });
    const item = await store.admitWeb(WEB_CHAT, 7, "write a note", { run: "run-1" });
    const chief = (await store.bot((await store.chief()).id)) as Bot;
    const file = join(sessions.workspaceFor(chief).root, "note.txt");

    expect(await dispatcher.tick()).toBe(1);
    const card = await sink.nextCard();
    expect(card).toMatchObject({ tool: "Write", run: "run-1", bot: chief.id });
    expect(card.preview).toContain("note.txt");
    expect(card.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(card.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(dispatcher.approvals(7)).toEqual([card]);
    expect(dispatcher.approvals(8)).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(await status(item.id)).toBe("running");
    const row = (
      await db.query("SELECT user,tool,digest,decision FROM approvals WHERE id=?", [card.id])
    )[0];
    expect(row).toMatchObject({ user: 7, tool: "Write", digest: card.digest, decision: null });

    expect(await dispatcher.decide(card.id, true, 8)).toBe(false);
    expect(await dispatcher.decide(card.id, true, 7)).toBe(true);
    expect(await dispatcher.decide(card.id, true, 7)).toBe(false);
    await dispatcher.idle();

    expect(readFileSync(file, "utf8")).toBe("kept");
    expect(sink.texts()).toEqual(["done"]);
    expect(await status(item.id)).toBe("completed");
    const decided = (
      await db.query("SELECT decision,source FROM approvals WHERE id=?", [card.id])
    )[0];
    expect(decided).toMatchObject({ decision: "allowed", source: "user" });
    expect(dispatcher.approvals(7)).toEqual([]);
  });

  it("an approval answered in another process reaches the run waiting here", async () => {
    const provider = gated([
      toolCall("Write", { path: "note.txt", content: "kept" }),
      reply("done"),
    ]);
    const { db, store, sessions, sink, dispatcher, status, config } = await setup(provider, {
      policy: "ask",
    });
    const other = await elsewhere(db, config);
    const item = await store.admitWeb(WEB_CHAT, 7, "write a note");
    const chief = (await store.bot((await store.chief()).id)) as Bot;
    const file = join(sessions.workspaceFor(chief).root, "note.txt");

    expect(await dispatcher.tick()).toBe(1);
    const card = await sink.nextCard();
    expect(await other.dispatcher.decide(card.id, true, 8)).toBe(false);
    expect(await other.dispatcher.decide("no-such-card", true, 7)).toBe(false);
    expect(await other.dispatcher.decide(card.id, true, 7)).toBe(true);
    expect(await other.dispatcher.decide(card.id, false, 7)).toBe(false);
    await dispatcher.idle();

    expect(readFileSync(file, "utf8")).toBe("kept");
    expect(sink.texts()).toEqual(["done"]);
    expect(await status(item.id)).toBe("completed");
    const decided = (
      await db.query("SELECT decision,source FROM approvals WHERE id=?", [card.id])
    )[0];
    expect(decided).toMatchObject({ decision: "allowed", source: "user" });
    expect(dispatcher.approvals(7)).toEqual([]);
  });

  it("an approval refused in another process is refused here", async () => {
    const provider = gated([
      toolCall("Write", { path: "note.txt", content: "kept" }),
      reply("left it"),
    ]);
    const { db, store, sessions, sink, dispatcher, config } = await setup(provider, {
      policy: "ask",
    });
    const other = await elsewhere(db, config);
    await store.admitWeb(WEB_CHAT, 7, "write a note");
    const chief = (await store.bot((await store.chief()).id)) as Bot;

    expect(await dispatcher.tick()).toBe(1);
    const card = await sink.nextCard();
    expect(await other.dispatcher.decide(card.id, false, 7)).toBe(true);
    await dispatcher.idle();
    expect(existsSync(join(sessions.workspaceFor(chief).root, "note.txt"))).toBe(false);
    expect(sink.texts()).toEqual(["left it"]);
  });

  it.each(["cancelling", "cancelled"])(
    "a run another process marked %s stops here",
    async (marked) => {
      const gate = new Gate();
      const { db, store, sink, dispatcher } = await setup(gated([reply("never")], { 0: gate }));
      const item = await store.admitWeb(WEB_CHAT, 7, "long job", { run: "run-9" });

      expect(await dispatcher.tick()).toBe(1);
      await gate.reached;
      await db.run("UPDATE inbox SET status=? WHERE instance='main' AND id=?", [marked, item.id]);
      await dispatcher.idle();
      expect(dispatcher.running()).toBe(0);
      expect(sink.texts()).toEqual([]);
    },
  );

  it("a delegated run's approval appears on the chief's route and the decision reaches it", async () => {
    const provider = gated([
      toolCall("delegate_task", { bot_name: "Writer", task: "write the note" }),
      toolCall("Write", { path: "note.txt", content: "from the writer" }),
      reply("written"),
      reply("the writer wrote it"),
    ]);
    const { db, store, sessions, sink, dispatcher, status } = await setup(provider, {
      policy: "ask",
    });
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    const file = join(sessions.workspaceFor(writer).root, "note.txt");
    const item = await store.admitWeb(WEB_CHAT, 7, "have the writer write it", { run: "run-1" });

    expect(await dispatcher.tick()).toBe(1);
    const card = await sink.nextCard();
    expect(card).toMatchObject({ tool: "Write", bot: writer.id, run: "run-1" });
    expect(sink.cards[0]?.route).toMatchObject({ chat: WEB_CHAT, user: 7 });
    expect(dispatcher.approvals(7)).toEqual([card]);
    expect(existsSync(file)).toBe(false);
    expect(await dispatcher.decide(card.id, true, 7)).toBe(true);
    await dispatcher.idle();

    expect(readFileSync(file, "utf8")).toBe("from the writer");
    expect(sink.texts()).toEqual(["the writer wrote it"]);
    expect(await status(item.id)).toBe("completed");
    const decided = (
      await db.query("SELECT user,decision,source FROM approvals WHERE id=?", [card.id])
    )[0];
    expect(decided).toMatchObject({ user: 7, decision: "allowed", source: "user" });
    const delegations = await db.query("SELECT bot,status,answer FROM delegations");
    expect(delegations).toEqual([{ bot: writer.id, status: "completed", answer: "written" }]);
    expect(dispatcher.approvals(7)).toEqual([]);
  });

  it("stop ends the run and marks the item cancelled", async () => {
    const gate = new Gate();
    const provider = gated([reply("never")], { 0: gate });
    const { store, sink, dispatcher, status } = await setup(provider);
    const running = await store.admitWeb(WEB_CHAT, 7, "long job");
    const queued = await store.admitWeb(WEB_CHAT, 7, "after that");
    const route = await store.conversation(WEB_CHAT, 7);

    expect(await dispatcher.tick()).toBe(1);
    await gate.reached;
    expect(await dispatcher.stop(route)).toEqual({ stopped: true, cleared: 1 });

    expect(await status(running.id)).toBe("cancelled");
    expect(await status(queued.id)).toBe("cancelled");
    expect(sink.texts().at(-1)).toContain("[Run cancelled]");
    expect(await dispatcher.tick()).toBe(0);
    expect(await dispatcher.stop(route)).toEqual({ stopped: false, cleared: 0 });
  });

  it("stopping the chief stops its running delegation and frees the bot", async () => {
    const gate = new Gate();
    const provider = gated(
      [
        toolCall("delegate_task", { bot_name: "Writer", task: "think it over" }),
        // The held call never takes its reply, so this is what the writer's next call gets.
        reply("still the writer"),
      ],
      { 1: gate },
    );
    const { db, store, sessions, dispatcher, status } = await setup(provider);
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    const item = await store.admitWeb(WEB_CHAT, 7, "ask the writer");
    const route = await store.conversation(WEB_CHAT, 7);

    expect(await dispatcher.tick()).toBe(1);
    await gate.reached;
    expect(sessions.isBusy(writer.id)).toBe(true);
    expect(await dispatcher.stop(route)).toEqual({ stopped: true, cleared: 0 });
    expect(await status(item.id)).toBe("cancelled");

    for (let i = 0; i < 400 && sessions.isBusy(writer.id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sessions.isBusy(writer.id)).toBe(false);
    const rows = await db.query("SELECT status FROM delegations WHERE bot=?", [writer.id]);
    expect(rows).toEqual([{ status: "cancelled" }]);
    expect(await db.query("SELECT name FROM leases")).toEqual([]);
    // The writer is free for new work at once.
    expect(await sessions.delegate(route, writer, "something else")).toBe("still the writer");
  });

  it("steer reaches a running session and is refused when idle", async () => {
    const gate = new Gate();
    const provider = gated([reply("first part"), reply("steered")], { 0: gate });
    const { store, sink, dispatcher } = await setup(provider);
    const route = await store.conversation(WEB_CHAT, 7);

    expect(await dispatcher.steer(route, "too early")).toBe(false);
    expect(await dispatcher.followUp(route, "too early")).toBe(false);

    await store.admitWeb(WEB_CHAT, 7, "start");
    expect(await dispatcher.tick()).toBe(1);
    await gate.reached;
    expect(await dispatcher.steer(route, "also this")).toBe(true);
    gate.release();
    await dispatcher.idle();

    expect(said(provider.requests[1])).toEqual(["start", "first part", "also this"]);
    expect(sink.texts()).toEqual(["steered"]);
    expect(await dispatcher.steer(route, "too late")).toBe(false);
  });

  it("control commands typed as messages are kept out of runs", async () => {
    const provider = gated([reply("a path")]);
    const { db, store, sink, dispatcher, status } = await setup(provider);
    const control = await store.admitWeb(WEB_CHAT, 7, "/stop");
    const named = await store.admitWeb(WEB_CHAT, 7, "/model@somebot fast");
    const path = await store.admitWeb(WEB_CHAT, 7, "/usr/local/bin is on my path?");
    const full = await store.admitWeb(WEB_CHAT, 9, "anything");
    await db.run("UPDATE inbox SET status='rejected' WHERE instance='main' AND id=?", [full.id]);

    expect(await dispatcher.tick()).toBe(1);
    await dispatcher.idle();

    expect(await status(control.id)).toBe("completed");
    expect(await status(named.id)).toBe("completed");
    expect(await status(full.id)).toBe("completed");
    expect(await status(path.id)).toBe("completed");
    expect(provider.requests).toHaveLength(1);
    expect(said(provider.requests[0])).toEqual(["/usr/local/bin is on my path?"]);
    const texts = sink.texts();
    expect(texts.filter((t) => t.includes("controls on the page"))).toHaveLength(2);
    expect(texts).toContain("The prompt queue is full right now; retry later.");
    expect(texts).toContain("a path");
  });

  it("interrupted tasks are reported once", async () => {
    const { store, sink, dispatcher } = await setup(gated([]));
    const chief = await store.chief();
    const task = await store.addTask({
      chat: WEB_CHAT,
      user: 7,
      actor: 7,
      thread: 0,
      bot: chief.id,
      goal: "tidy up",
      policy: "auto",
      followUp: false,
    });
    await store.recover();

    expect(await dispatcher.reportInterrupted()).toBe(1);
    expect(sink.sent).toMatchObject([
      {
        route: { chat: WEB_CHAT, user: 7 },
        text: `Task #${task} was interrupted and not replayed.`,
      },
    ]);
    expect(await dispatcher.reportInterrupted()).toBe(0);
    expect(sink.sent).toHaveLength(1);
  });

  it("interrupted tasks from other chats are left alone", async () => {
    const { db, store, sink, dispatcher } = await setup(gated([]));
    const chief = await store.chief();
    const task = (chat: number, user: number) =>
      store.addTask({
        chat,
        user,
        actor: user,
        thread: 0,
        bot: chief.id,
        goal: "tidy up",
        policy: "auto",
        followUp: false,
      });
    const elsewhere = await task(555, 9);
    const web = await task(WEB_CHAT, 7);
    await store.recover();

    expect(await dispatcher.reportInterrupted()).toBe(1);
    expect(sink.sent).toMatchObject([
      {
        route: { chat: WEB_CHAT, user: 7 },
        text: `Task #${web} was interrupted and not replayed.`,
      },
    ]);
    const rows = await db.query("SELECT reported FROM tasks WHERE id=?", [elsewhere]);
    expect(rows).toEqual([{ reported: 0 }]);
    const routes = await db.query("SELECT chat FROM routes WHERE chat=555");
    expect(routes).toEqual([]);
  });
});
