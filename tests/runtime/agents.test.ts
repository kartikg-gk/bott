import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider, StreamEvent } from "../../src/agent/providers/types.ts";
import { emptyUsage } from "../../src/agent/transcript.ts";
import type { Bot } from "../../src/bots/bots.ts";
import { savedSession } from "../../src/bots/profiles.ts";
import type { Database } from "../../src/db/database.ts";
import { BackgroundAgents, type Timer } from "../../src/runtime/agents.ts";
import { type RuntimeConfig, SessionManager } from "../../src/runtime/sessions.ts";
import { answerTeamCall, jobTools, teamTools } from "../../src/runtime/team.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";
import { MemorySink } from "../support/memorySink.ts";

const NOW = 1_800_000_000;
/** A scripted reply that waits until the run is stopped. */
const HANG = "\u0000hang";

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

/** A timer the test fires by hand. */
function manualTimer() {
  const pending: { ms: number; fire: () => void; live: boolean }[] = [];
  const timer: Timer = (fire, ms) => {
    const entry = { ms, fire, live: true };
    pending.push(entry);
    return () => {
      entry.live = false;
    };
  };
  const fireAll = () => {
    for (const entry of pending.splice(0)) if (entry.live) entry.fire();
  };
  return { timer, pending, fireAll };
}

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const folders: string[] = [];
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
    await Promise.all(open.splice(0).map((db) => db.close()));
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  async function setup(texts: string[], opts: { timer?: Timer; hosted?: boolean } = {}) {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main", { clock: () => NOW });
    const root = mkdtempSync(join(tmpdir(), "agents-"));
    folders.push(root);
    const config: RuntimeConfig = {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: opts.hosted ? null : join(root, "sessions"),
      policy: "auto",
      model: "m",
      idleSeconds: 60,
    };
    const seen: { bot: string; tools: string[]; context: string }[] = [];
    let started: () => void = () => {};
    const factory = (bot: Bot): ModelProvider => ({
      id: "fake",
      async *stream(req) {
        seen.push({
          bot: bot.name,
          tools: req.tools.map((t) => t.name),
          context: JSON.stringify(req.messages),
        });
        const next = texts.shift();
        if (next === undefined) throw new Error("no scripted reply left");
        if (next === HANG) {
          started();
          await new Promise<void>((resolve) => {
            if (req.signal.aborted) resolve();
            req.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "error", message: "aborted" };
          return;
        }
        yield* reply(next);
      },
    });
    const sessions = new SessionManager(config, store, factory);
    managers.push(sessions);
    const sink = new MemorySink();
    const agents = new BackgroundAgents(store, sessions, sink, { timer: opts.timer });
    const route = await store.conversation(1, 1);
    const ctx = { store, sessions, route, actor: 1, agents: sessions.agents };
    const call = async (name: string, input: unknown) => {
      const out = await answerTeamCall(ctx, { id: "c", name, input });
      const first = out.content[0];
      return { text: first?.type === "text" ? first.text : "", isError: out.isError === true };
    };
    /** Resolves once a hanging reply has started. */
    const hung = () =>
      new Promise<void>((resolve) => {
        started = resolve;
      });
    return { db, store, sessions, sink, agents, route, seen, call, hung };
  }

  it("a background agent runs and reports when asked", async () => {
    const { db, store, sink, agents, call } = await setup(["found it"]);
    const out = await call("spawn_agent", { goal: "look it up", follow_up: true });
    expect(out).toEqual({ text: "Started task #1 in the background.", isError: false });
    await agents.settled();
    const done = await store.task(1);
    expect(done).toMatchObject({ status: "completed", answer: "found it", policy: "deny" });
    const helper = await store.bot(done?.bot as string);
    expect(helper).toMatchObject({
      temporary: true,
      role: "A short-lived agent with a single goal.",
    });
    expect(helper?.name).toMatch(/^Agent-[0-9a-f]{8}$/);
    expect(sink.texts()).toEqual([`Task #1 (${helper?.name}), completed:\nfound it`]);
    const reports = await db.query("SELECT status,text FROM inbox");
    expect(reports).toHaveLength(1);
    expect(String(reports[0]?.text)).toContain(`Task #1 (${helper?.name}) ended: completed.`);
    expect(String(reports[0]?.text)).toContain("found it");
    expect(agents.running()).toBe(0);
  });

  it("a background agent on a named bot records its delegation", async () => {
    const { db, store, agents, route } = await setup(["drafted"]);
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    const id = await agents.spawn({
      goal: "draft it",
      bot: "writer",
      writer: false,
      followUp: false,
      route,
      actor: 1,
    });
    expect(id).toBe(1);
    await agents.settled();
    expect(await store.task(1)).toMatchObject({ bot: writer.id, status: "completed" });
    expect(await db.query("SELECT bot,status,answer FROM delegations")).toEqual([
      { bot: writer.id, status: "completed", answer: "drafted" },
    ]);
    expect(await db.query("SELECT id FROM inbox")).toEqual([]);
  });

  it("a fifth background agent is refused", async () => {
    const { store, agents, route, call } = await setup([HANG, HANG, HANG, HANG]);
    const request = { goal: "wait", writer: false, followUp: false, route, actor: 1 };
    for (let i = 1; i <= 4; i++) expect(await agents.spawn(request)).toBe(i);
    expect(agents.running()).toBe(4);
    expect(await agents.spawn(request)).toBe("At most 4 background agents can run at once.");
    const tool = await call("spawn_agent", { goal: "more" });
    expect(tool).toEqual({ text: "At most 4 background agents can run at once.", isError: true });
    expect(await call("cancel_task", { task_id: 2 })).toEqual({
      text: "Cancelling.",
      isError: false,
    });
    for (const id of [1, 3, 4]) expect(agents.cancel(id)).toBe(true);
    await agents.settled();
    expect(agents.cancel(1)).toBe(false);
    for (const id of [1, 2, 3, 4]) expect((await store.task(id))?.status).toBe("cancelled");
  });

  it("an agent past its time limit finishes timed out", async () => {
    const clock = manualTimer();
    const { store, sink, agents, route, hung } = await setup([HANG], { timer: clock.timer });
    const waiting = hung();
    await agents.spawn({ goal: "slow", writer: false, followUp: false, route, actor: 1 });
    await waiting;
    expect(clock.pending.map((p) => p.ms)).toEqual([1800 * 1000]);
    clock.fireAll();
    await agents.settled();
    expect((await store.task(1))?.status).toBe("timed_out");
    expect(sink.texts()[0]).toMatch(/^Task #1 \(Agent-[0-9a-f]{8}\), timed_out:/);
  });

  it("a reader agent has no write tools", async () => {
    const { seen, agents, route } = await setup(["read only"]);
    await agents.spawn({ goal: "read", writer: false, followUp: false, route, actor: 1 });
    await agents.settled();
    expect(seen).toHaveLength(1);
    const tools = seen[0]?.tools ?? [];
    expect(tools).toContain("Read");
    for (const name of ["Write", "Edit", "Bash"]) expect(tools).not.toContain(name);
    for (const t of teamTools()) expect(tools).not.toContain(t.name);
  });

  it("a writer agent is refused on the local computer", async () => {
    const { db, store, agents, route, call } = await setup([]);
    const before = (await store.bots({ temporary: true })).length;
    const refusal = await agents.spawn({
      goal: "change it",
      writer: true,
      followUp: false,
      route,
      actor: 1,
    });
    expect(refusal).toBe(
      "Writer agents need a sandboxed computer; this gateway runs them on the local machine.",
    );
    expect((await call("spawn_writer_agent", { goal: "change it" })).isError).toBe(true);
    expect(await db.query("SELECT id FROM tasks")).toEqual([]);
    expect((await store.bots({ temporary: true })).length).toBe(before);
    const approval = Object.fromEntries(
      [...teamTools(), ...jobTools()].map((t) => [t.name, !t.readOnly]),
    );
    expect(approval).toMatchObject({
      spawn_agent: false,
      spawn_writer_agent: true,
      schedule_job: true,
      list_scheduled_jobs: false,
      cancel_scheduled_job: true,
    });
  });

  it("schedule_job adds a job and list and cancel act on it", async () => {
    const { store, call } = await setup([]);
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    const out = await call("schedule_job", {
      when: "every 30m",
      task: "check the news",
      bot_name: "Writer",
    });
    expect(out).toEqual({ text: "Scheduled job 1.", isError: false });
    expect(await store.job(1)).toMatchObject({
      bot: writer.id,
      task: "check the news",
      spec: "every:1800",
      nextRun: NOW + 1800,
      actor: 1,
      status: "active",
    });
    expect((await call("schedule_job", { when: "daily 08:00", task: "brief" })).text).toBe(
      "Scheduled job 2.",
    );
    expect((await store.job(2))?.bot).toBe((await store.chief()).id);
    expect((await call("schedule_job", { when: "sometime", task: "x" })).isError).toBe(true);
    expect(
      (await call("schedule_job", { when: "every 1h", task: "x", bot_name: "Nobody" })).text,
    ).toBe("Choose a persistent bot");
    const listed = JSON.parse((await call("list_scheduled_jobs", {})).text);
    expect(listed).toEqual([
      {
        id: 2,
        bot: "Chief of Staff",
        task: "brief",
        schedule: "daily:08:00",
        status: "active",
      },
      { id: 1, bot: "Writer", task: "check the news", schedule: "every:1800", status: "active" },
    ]);
    expect(await call("cancel_scheduled_job", { job_id: 1 })).toEqual({
      text: "Cancelled.",
      isError: false,
    });
    expect((await store.job(1))?.status).toBe("cancelled");
    expect(await call("cancel_scheduled_job", { job_id: 1 })).toEqual({
      text: "There is no job with that number that can be stopped",
      isError: true,
    });
    expect((await call("cancel_scheduled_job", { job_id: 99 })).isError).toBe(true);
    expect(JSON.parse((await call("list_scheduled_jobs", {})).text)).toHaveLength(1);
  });

  it("five spawns in one reply start only four", async () => {
    const { store, agents, call } = await setup(Array(8).fill(HANG));
    // Four made together always all start.
    const four = await Promise.all(
      [1, 2, 3, 4].map((n) => call("spawn_agent", { goal: `goal ${n}` })),
    );
    expect(four.map((o) => o.isError)).toEqual([false, false, false, false]);
    expect(agents.running()).toBe(4);
    for (const id of [1, 2, 3, 4]) agents.cancel(id);
    await agents.settled();
    const outs = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => call("spawn_agent", { goal: `goal ${n}` })),
    );
    expect(outs.filter((o) => !o.isError)).toHaveLength(4);
    expect(outs.filter((o) => o.isError)).toEqual([
      { text: "At most 4 background agents can run at once.", isError: true },
    ]);
    expect(agents.running()).toBe(4);
    expect(await store.runningTasks()).toHaveLength(4);
    for (const id of [5, 6, 7, 8, 9]) agents.cancel(id);
    await agents.settled();
  });

  it("finished background runs leave no transcript in memory", async () => {
    const clock = manualTimer();
    const { store, sessions, agents, route, hung } = await setup(["done", HANG, HANG], {
      timer: clock.timer,
      hosted: true,
    });
    await store.createBot({ name: "Writer", role: "Drafts text" });
    const base = { writer: false, followUp: false, route, actor: 1 };
    await agents.spawn({ ...base, goal: "finish" });
    await agents.settled();
    let waiting = hung();
    await agents.spawn({ ...base, goal: "be cancelled", bot: "Writer" });
    await waiting;
    agents.cancel(2);
    await agents.settled();
    waiting = hung();
    await agents.spawn({ ...base, goal: "run long" });
    await waiting;
    clock.fireAll();
    await agents.settled();
    await agents.spawn({ ...base, goal: "fail" });
    await agents.settled();
    const statuses = await Promise.all(
      [1, 2, 3, 4].map(async (id) => (await store.task(id))?.status),
    );
    expect(statuses).toEqual(["completed", "cancelled", "timed_out", "failed"]);
    expect(sessions.transcriptsInMemory()).toBe(0);
  });

  it("a background run on a named bot continues and saves that bot's session", async () => {
    const { store, sessions, agents, route, seen } = await setup(["first answer", "second answer"]);
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    await sessions.delegate(route, writer, "first job");
    const file = await savedSession(store, writer.id);
    expect(file).not.toBeNull();
    await agents.spawn({
      goal: "second job",
      bot: "Writer",
      writer: false,
      followUp: false,
      route,
      actor: 1,
    });
    await agents.settled();
    expect((await store.task(1))?.status).toBe("completed");
    expect(seen[1]?.context).toContain("first job");
    expect(seen[1]?.context).toContain("first answer");
    expect(await savedSession(store, writer.id)).toBe(file);
    const saved = readFileSync(file as string, "utf8");
    expect(saved).toContain("second job");
    expect(saved).toContain("second answer");
  });

  it("a kept temporary agent remembers its goal", async () => {
    const { store, sessions, agents, route, seen } = await setup(["noted", "it was the plan"]);
    await agents.spawn({
      goal: "remember the plan",
      writer: false,
      followUp: false,
      route,
      actor: 1,
    });
    await agents.settled();
    const botId = (await store.task(1))?.bot as string;
    expect(await store.keepBot(botId)).toBe(true);
    expect(await sessions.delegate(route, { id: botId }, "what was it?")).toBe("it was the plan");
    expect(seen[1]?.context).toContain("remember the plan");
    expect(seen[1]?.context).toContain("noted");
  });

  it("a specialist bot can schedule, list and cancel its own jobs, and has no team tools", async () => {
    const { store, sessions, seen, call } = await setup(["hello"]);
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    const theirs = await store.switchBot(await store.conversation(2, 1), writer.id);
    await sessions.prompt(theirs, "hi");
    const offered = seen[0]?.tools ?? [];
    for (const t of jobTools()) expect(offered).toContain(t.name);
    for (const t of teamTools()) expect(offered).not.toContain(t.name);
    expect((await call("schedule_job", { when: "every 1h", task: "chief job" })).text).toBe(
      "Scheduled job 1.",
    );
    const ctx = { store, sessions, route: theirs, actor: 1, bot: writer };
    const ask = async (name: string, input: unknown) => {
      const out = await answerTeamCall(ctx, { id: "c", name, input });
      const first = out.content[0];
      return { text: first?.type === "text" ? first.text : "", isError: out.isError === true };
    };
    expect(await ask("schedule_job", { when: "every 30m", task: "my job" })).toEqual({
      text: "Scheduled job 2.",
      isError: false,
    });
    expect(await store.job(2)).toMatchObject({ bot: writer.id, chat: 2, task: "my job" });
    expect(
      await ask("schedule_job", { when: "every 1h", task: "x", bot_name: "Chief of Staff" }),
    ).toEqual({ text: "A specialist may only schedule work for itself", isError: true });
    expect(
      (await ask("schedule_job", { when: "every 1h", task: "y", bot_name: "writer" })).text,
    ).toBe("Scheduled job 3.");
    const listed = JSON.parse((await ask("list_scheduled_jobs", {})).text);
    expect(listed.map((j: { id: number }) => j.id)).toEqual([3, 2]);
    expect(await ask("cancel_scheduled_job", { job_id: 1 })).toEqual({
      text: "There is no job with that number that can be stopped",
      isError: true,
    });
    expect((await ask("cancel_scheduled_job", { job_id: 2 })).text).toBe("Cancelled.");
    expect((await store.job(1))?.status).toBe("active");
    const only = { text: "This tool is only for the chief of staff.", isError: true };
    expect(await ask("list_bots", {})).toEqual(only);
    expect(await ask("spawn_agent", { goal: "g" })).toEqual(only);
    expect(await ask("delegate_task", { bot_name: "Chief of Staff", task: "t" })).toEqual(only);
    expect(await store.tasks()).toEqual([]);
  });
});
