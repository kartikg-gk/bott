import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider, StreamEvent } from "../src/agent/providers/types.ts";
import { emptyUsage } from "../src/agent/transcript.ts";
import type { Database } from "../src/db/database.ts";
import { Lease } from "../src/db/leases.ts";
import { runRunner } from "../src/runner.ts";
import { type RuntimeConfig, SessionManager } from "../src/runtime/sessions.ts";
import { receiveWakeup, wakeupHistory } from "../src/schedule/wakeups.ts";
import { Store } from "../src/store/store.ts";
import { type Backend, backends, database } from "./support/fakeD1.ts";
import { MemorySink } from "./support/memorySink.ts";

const NOW = 1_800_000_000;
const HOUR = 3600;
/** A scripted reply that waits until the run is stopped. */
const HANG = "\u0000hang";
/** A scripted reply that fails the model call. */
const FAIL = "\u0000fail";
const POLL = 0.005;

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

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const folders: string[] = [];
  const managers: SessionManager[] = [];
  const stops: AbortController[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) stop.abort();
    await Promise.all(managers.splice(0).map((m) => m.close()));
    await Promise.all(open.splice(0).map((db) => db.close()));
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  /** A store and session manager on `db` whose clock reads `clock`. */
  async function side(db: Database, clock: () => number, texts: string[]) {
    const store = await Store.open(db, "main", { clock });
    const root = mkdtempSync(join(tmpdir(), "runner-"));
    folders.push(root);
    const config: RuntimeConfig = {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: join(root, "sessions"),
      policy: "auto",
      model: "m",
      idleSeconds: 60,
    };
    const prompts: string[] = [];
    let started: () => void = () => {};
    const factory = (): ModelProvider => ({
      id: "fake",
      async *stream(req) {
        const last = req.messages.at(-1);
        prompts.push(JSON.stringify(last?.content ?? ""));
        const next = texts.shift();
        if (next === undefined) throw new Error("no scripted reply left");
        if (next === FAIL) throw new Error("the model is down");
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
    const hung = () =>
      new Promise<void>((resolve) => {
        started = resolve;
      });
    return { store, sessions, sink, prompts, hung };
  }

  async function setup(texts: string[] = []) {
    const { db } = database(kind);
    open.push(db);
    let now = NOW;
    const parts = await side(db, () => now, texts);
    const chief = await parts.store.chief();
    const addJob = (over: Partial<Parameters<Store["addJob"]>[0]> = {}) =>
      parts.store.addJob({
        chat: 1,
        user: 1,
        actor: 1,
        thread: 0,
        bot: chief.id,
        task: "check the build",
        spec: `every:${HOUR}`,
        first: now - 1,
        ...over,
      });
    const once = () =>
      runRunner({ ...parts, instance: "main", once: true, poll: POLL, owner: "runner-a" });
    const loop = () => {
      const stop = new AbortController();
      stops.push(stop);
      const done = runRunner({
        ...parts,
        instance: "main",
        poll: POLL,
        owner: "runner-a",
        signal: stop.signal,
      });
      return { stop, done };
    };
    return {
      db,
      ...parts,
      chief,
      addJob,
      once,
      loop,
      clock: { set: (t: number) => (now = t), get: () => now },
    };
  }

  it("second runner refused", async () => {
    const { db, store, once, loop } = await setup();
    const first = loop();
    await until(async () => (await db.query("SELECT 1 FROM scheduler_leases")).length > 0);
    await expect(once()).rejects.toThrow("Another runner holds this instance; stop it or wait for its hold to run out");
    first.stop.abort();
    await first.done;
    expect(await db.query("SELECT * FROM leases")).toEqual([]);
    expect(await db.query("SELECT * FROM scheduler_leases")).toEqual([]);
    // With the first one gone, another may start.
    await once();
    expect((await store.jobs()).length).toBe(0);
  });

  it("runner takes over after the lease expires and interrupts the dead runner's job", async () => {
    const { db, store, sink, addJob, loop, hung } = await setup([HANG]);
    const id = await addJob();
    const waiting = hung();
    const dead = loop();
    await waiting;
    expect(await store.job(id)).toMatchObject({ running: true, nextRun: NOW + HOUR });

    // A second process whose clock has moved past the first runner's lease.
    let later = NOW + 30;
    const other = await side(db, () => later, []);
    const run = () =>
      runRunner({ ...other, instance: "main", once: true, poll: POLL, owner: "runner-b" });
    await expect(run()).rejects.toThrow("Another runner holds this instance; stop it or wait for its hold to run out");
    later = NOW + 61;
    await run();
    expect(await store.job(id)).toMatchObject({
      running: false,
      lastStatus: "interrupted",
      status: "active",
      nextRun: NOW + HOUR,
    });

    // The first runner finds its lease gone, stops its run and changes nothing.
    await expect(dead.done).rejects.toThrow(
      "Another runner took this instance over after this one's hold ran out",
    );
    expect(await store.job(id)).toMatchObject({ running: false, lastStatus: "interrupted" });
    expect(sink.texts()).toEqual([]);
    expect(other.sink.texts()).toEqual([]);
  });

  it("a due job runs once, is delivered and moves to its next run", async () => {
    const { db, store, sink, chief, addJob, once, prompts } = await setup(["all green"]);
    const id = await addJob();
    await once();
    expect(sink.texts()).toEqual([`Job #${id} (${chief.name}), completed:\nall green`]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("check the build");
    expect(await store.job(id)).toMatchObject({
      status: "active",
      running: false,
      lastStatus: "completed",
      lastAnswer: "all green",
      lastRun: NOW,
      nextRun: NOW + HOUR,
    });
    const logged = await db.query("SELECT text,direction FROM messages");
    expect(logged).toContainEqual({
      text: `Job #${id} (${chief.name}), completed:\nall green`,
      direction: "outbound",
    });
    // Not due again yet.
    await once();
    expect(sink.texts()).toHaveLength(1);
    expect(prompts).toHaveLength(1);
  });

  it("a one-off job finishes as completed and is not run again", async () => {
    const { store, sink, addJob, once, clock, prompts } = await setup(["sent the note"]);
    const id = await addJob({ spec: "once" });
    await once();
    expect(await store.job(id)).toMatchObject({
      status: "done",
      running: false,
      lastStatus: "completed",
      lastAnswer: "sent the note",
      nextRun: null,
    });
    clock.set(NOW + 10 * HOUR);
    await once();
    expect(prompts).toHaveLength(1);
    expect(sink.texts()).toHaveLength(1);
  });

  it("a failing job records its failure and stays scheduled", async () => {
    const { store, sink, chief, addJob, once } = await setup([FAIL]);
    const id = await addJob();
    await once();
    const after = await store.job(id);
    expect(after).toMatchObject({
      status: "active",
      running: false,
      lastStatus: "failed",
      nextRun: NOW + HOUR,
    });
    expect(after?.lastAnswer).toContain("the model is down");
    expect(sink.texts()).toHaveLength(1);
    expect(sink.texts()[0]).toMatch(new RegExp(`^Job #${id} \\(${chief.name}\\), failed:\\n`));
  });

  it("a job whose bot is busy elsewhere waits for a later tick and is not marked failed", async () => {
    const { db, store, sink, addJob, once, prompts } = await setup(["drafted"]);
    const writer = await store.createBot({ name: "Writer", role: "Writes." });
    const id = await addJob({ bot: writer.id, spec: "once" });
    // Another process is running the bot.
    const elsewhere = new Lease(db, `bot-${writer.id}`, { clock: () => NOW * 1000 });
    expect(await elsewhere.acquire()).toBe(true);
    await once();
    expect(await store.job(id)).toMatchObject({
      status: "active",
      running: false,
      lastStatus: null,
      lastAnswer: null,
    });
    expect((await store.job(id))?.nextRun).toBeLessThanOrEqual(NOW);
    expect(await db.query("SELECT * FROM delegations")).toEqual([]);
    expect(prompts).toEqual([]);
    expect(sink.texts()).toEqual([]);

    await elsewhere.release();
    await once();
    expect(await store.job(id)).toMatchObject({ status: "done", lastStatus: "completed" });
    expect(sink.texts()).toEqual([`Job #${id} (Writer), completed:\ndrafted`]);
    expect(await db.query("SELECT bot,task,status,answer FROM delegations")).toEqual([
      { bot: writer.id, task: "check the build", status: "completed", answer: "drafted" },
    ]);
  });

  it("cancelling a running job stops its run", async () => {
    const { store, sink, addJob, loop, hung } = await setup([HANG]);
    const id = await addJob();
    const waiting = hung();
    const runner = loop();
    await waiting;
    expect(await store.cancelJob(id, 1)).toBe(true);
    await until(async () => (await store.job(id))?.running === false);
    expect(await store.job(id)).toMatchObject({
      status: "cancelled",
      lastStatus: "cancelled",
      nextRun: null,
    });
    expect(sink.texts()).toEqual([]);
    runner.stop.abort();
    await runner.done;
  });

  it("a woken event job runs and its wake-up finishes", async () => {
    const { db, store, sink, chief, addJob, once } = await setup(["deployed fine"]);
    const id = await addJob({ spec: "event:deploy", first: null });
    await once();
    expect(sink.texts()).toEqual([]);
    expect(await receiveWakeup(db, "main", 1, "deploy", "d-1", NOW)).toBe("queued");
    await once();
    expect(sink.texts()).toEqual([`Job #${id} (${chief.name}), completed:\ndeployed fine`]);
    expect(await store.job(id)).toMatchObject({
      status: "active",
      running: false,
      lastStatus: "completed",
      nextRun: null,
    });
    const [wakeup] = await wakeupHistory(db, "main", id);
    expect(wakeup).toMatchObject({ status: "completed", claimed: NOW, finished: NOW });
  });

  it("stopping the runner interrupts its running job and releases its hold", async () => {
    const { db, store, sink, addJob, loop, hung } = await setup([HANG]);
    const id = await addJob();
    const waiting = hung();
    const runner = loop();
    await waiting;
    runner.stop.abort();
    await runner.done;
    expect(await store.job(id)).toMatchObject({ running: false, lastStatus: "interrupted" });
    expect(sink.texts()).toEqual([]);
    expect(await db.query("SELECT * FROM leases")).toEqual([]);
    expect(await db.query("SELECT * FROM scheduler_leases")).toEqual([]);
  });
});
