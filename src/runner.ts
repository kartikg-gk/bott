/**
 * The process that owns an instance's scheduled work. Web requests are short and many; scheduled
 * jobs and event wake-ups need one long-lived owner. The runner holds a database lease for the
 * instance, renewed while it runs, so a second runner is refused and one that died is replaced
 * once its lease runs out. Only the holder settles work an earlier process left unfinished.
 */

import { randomUUID } from "node:crypto";
import { Lease } from "./db/leases.ts";
import { BotBusy, type SessionManager } from "./runtime/sessions.ts";
import type { Sink } from "./runtime/sink.ts";
import { MAX_ANSWER } from "./runtime/team.ts";
import { nextRun } from "./schedule/when.ts";
import type { Route } from "./store/routes.ts";
import type { ClaimedJob, Store } from "./store/store.ts";
import type { DelegationStatus } from "./store/work.ts";

/** How long the runner's hold lasts without renewal, in seconds. */
const RUNNER_SECONDS = 60;
/** How often the runner looks for due work, in seconds. */
const POLL_SECONDS = 2;

const REFUSED = "Another runner holds this instance; stop it or wait for its hold to run out";
const TAKEN_OVER = "Another runner took this instance over after this one's hold ran out";

export interface RunnerOptions {
  /** Its clock is the runner's clock, for claims and both holds. */
  store: Store;
  sessions: SessionManager;
  sink: Sink;
  instance: string;
  /** Run only the work due at the start, wait for it, then return. */
  once?: boolean;
  /** Seconds between looks for due work. */
  poll?: number;
  /** Seconds the runner's hold lasts without renewal. */
  ttl?: number;
  /** The scheduler owner recorded on claims; a fresh one by default. */
  owner?: string;
  /** Most jobs running at once; more due jobs wait for a free place. */
  workers?: number;
  /** Stops a runner that is not running once; its running jobs end interrupted. */
  signal?: AbortSignal;
}

/** Why a run was stopped before it ended by itself. */
type StopReason = "cancelled" | "interrupted";

interface Running {
  job: ClaimedJob;
  controller: AbortController;
  reason: StopReason | null;
  done: Promise<void>;
}

/** A job that cannot run as asked; it fails with this message. */
class CannotRun extends Error {}

/**
 * Runs due jobs and woken event jobs until stopped. Throws when another runner holds the
 * instance, and when another runner takes over after this one's lease ran out.
 */
export async function runRunner(opts: RunnerOptions): Promise<void> {
  const runner = new Runner(opts);
  await runner.start();
  try {
    if (opts.once) {
      await runner.tick();
      await runner.drain();
      return;
    }
    while (!opts.signal?.aborted) {
      await runner.tick();
      await runner.pause();
    }
  } finally {
    await runner.stop();
  }
}

class Runner {
  private readonly store: Store;
  private readonly lease: Lease;
  private readonly owner: string;
  private readonly ttl: number;
  private readonly pollMs: number;
  private readonly active = new Map<number, Running>();
  private lost = false;

  constructor(private readonly opts: RunnerOptions) {
    this.store = opts.store;
    this.ttl = opts.ttl ?? RUNNER_SECONDS;
    // The holds are renewed at every look, so looks come well inside the hold's time.
    this.pollMs = Math.min(opts.poll ?? POLL_SECONDS, this.ttl / 3) * 1000;
    this.lease = new Lease(this.store.ctx.db, `runner-${opts.instance}`, {
      ttlSeconds: this.ttl,
      clock: () => this.store.ctx.clock() * 1000,
    });
    this.owner = opts.owner ?? randomUUID().replaceAll("-", "");
  }

  /** Takes the runner lease, then the scheduler row, then settles what was left unfinished. */
  async start(): Promise<void> {
    if (!(await this.lease.acquire())) throw new Error(REFUSED);
    let held = false;
    try {
      held = await this.store.holdScheduler(this.owner, this.ttl);
      if (!held) throw new Error(REFUSED);
      await this.store.recover();
    } catch (error) {
      if (held) await this.store.releaseScheduler(this.owner).catch(() => {});
      await this.lease.release().catch(() => {});
      throw error;
    }
  }

  /** Renews both holds, stops cancelled runs, then claims and starts what is due. */
  async tick(): Promise<void> {
    await this.watch();
    const room = (this.opts.workers ?? Number.POSITIVE_INFINITY) - this.active.size;
    if (room <= 0) return;
    const now = this.store.ctx.clock();
    const busy = new Set<string>();
    for (const running of this.active.values()) busy.add(running.job.bot);
    for (const bot of await this.store.bots({ temporary: true })) {
      if (this.opts.sessions.isBusy(bot.id)) busy.add(bot.id);
    }
    const due = await this.store.claimDue(now, {
      owner: this.owner,
      next: nextRun,
      busyBots: [...busy],
      ...(Number.isFinite(room) ? { limit: room } : {}),
    });
    for (const job of due) this.launch(job);
  }

  /** Waits for every running job, still renewing the holds and watching for cancellations. */
  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.race([this.settled(), this.pause()]);
      if (this.active.size > 0) await this.watch();
    }
  }

  /** Waits one poll interval, or less when the runner is stopped. */
  pause(): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.opts.signal;
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, this.pollMs);
      if (signal?.aborted) done();
      else signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Interrupts whatever still runs and gives up both holds. */
  async stop(): Promise<void> {
    for (const running of this.active.values()) this.halt(running, "interrupted");
    await this.settled();
    if (this.lost) return;
    await this.store.releaseScheduler(this.owner).catch(() => {});
    await this.lease.release().catch(() => {});
  }

  /** Renews both holds and stops runs whose job was cancelled. Throws once the hold is gone. */
  private async watch(): Promise<void> {
    if (!(await this.lease.renew()) || !(await this.store.holdScheduler(this.owner, this.ttl))) {
      this.lost = true;
      throw new Error(TAKEN_OVER);
    }
    for (const running of this.active.values()) {
      const current = await this.store.job(running.job.id);
      if (current?.status === "cancelled") this.halt(running, "cancelled");
    }
  }

  private halt(running: Running, reason: StopReason): void {
    if (running.reason !== null) return;
    running.reason = reason;
    running.controller.abort();
  }

  private async settled(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((r) => r.done));
    }
  }

  private launch(job: ClaimedJob): void {
    const running: Running = {
      job,
      controller: new AbortController(),
      reason: null,
      done: Promise.resolve(),
    };
    this.active.set(job.id, running);
    running.done = this.run(running)
      // A store failure while settling leaves the job for recovery to close.
      .catch(() => {})
      .finally(() => {
        this.active.delete(job.id);
      });
  }

  /** Runs a claimed job on its bot's saved session, tells its conversation and records the end. */
  private async run(running: Running): Promise<void> {
    const { job } = running;
    const { store, sessions } = this.opts;
    const claimedAt = job.lastRun as number;
    let status = "interrupted";
    let answer = "";
    let delegation: number | null = null;
    let route: Route | undefined;
    // From the claim on, every failure ends below, so the job is never left claimed.
    try {
      route = await store.conversation(job.chat, job.user, job.thread);
      const bot = await store.bot(job.bot);
      if (!bot) throw new CannotRun("The bot for this job was removed.");
      if (!bot.chief) {
        delegation = await store.beginDelegation(route, bot.id, job.task);
        if (delegation === null) throw new BotBusy();
      }
      const result = await sessions.background(route, bot, job.task, {
        readOnly: false,
        signal: running.controller.signal,
      });
      answer = result.text;
      status = running.reason ?? result.outcome;
      // A stopped run tells nobody: a cancel was asked for, and an interrupt is recorded.
      if (running.reason === null) {
        try {
          await this.deliver(
            route,
            `Job #${job.id} (${bot.name}), ${status}:\n${answer || "No answer."}`,
          );
        } catch {
          status = status === "completed" ? "delivery_failed" : "failed";
          await this.notify(route, `Job #${job.id} failed. It was not retried.`);
        }
      }
    } catch (error) {
      if (error instanceof BotBusy) {
        // The bot is working elsewhere: nothing ran, so the job waits for a later look.
        try {
          if (delegation !== null) await store.dropDelegation(delegation);
          delegation = null;
          if (await store.releaseJob(job)) return;
        } catch {
          // It could not be handed back, so it ends here rather than staying claimed.
        }
        status = running.reason ?? "interrupted";
      } else if (running.reason !== null) {
        status = running.reason;
      } else if (error instanceof CannotRun) {
        status = "failed";
        answer = error.message;
        await this.notify(route, `Job #${job.id} could not run: ${error.message}`);
      } else {
        status = "failed";
        await this.notify(route, `Job #${job.id} failed. It was not retried.`);
      }
    } finally {
      if (delegation !== null) {
        // Recovery closes a delegation left running; the job itself must still end.
        await store
          .finishDelegation(delegation, status as DelegationStatus, answer)
          .catch(() => {});
      }
    }
    await store.finishJob(job.id, status, answer.slice(0, MAX_ANSWER), { claimedAt });
  }

  /** Logs the answer on the conversation and sends it. */
  private async deliver(route: Route, text: string): Promise<void> {
    await this.store.logMessage(route, text, "out");
    await this.opts.sink.send(route, text);
  }

  /** Tells the conversation something went wrong, if it can be told. */
  private async notify(route: Route | undefined, text: string): Promise<void> {
    if (route) await this.opts.sink.send(route, text).catch(() => {});
  }
}
