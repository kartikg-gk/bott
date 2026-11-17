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
import { traced } from "./tracing.ts";

/** How long the runner's hold lasts without renewal, in seconds. */
const RUNNER_SECONDS = 60;
/** How often the runner looks for due work, in seconds. */
const POLL_SECONDS = 2;
/** How often old records are dropped, in seconds. */
const TIDY_SECONDS = 3600;

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
  /**
   * Stops a runner that is not running once: it claims nothing more, gives its running jobs
   * `graceMs` to end by themselves, and interrupts those still going.
   */
  signal?: AbortSignal;
  /** Milliseconds running jobs may take to end once the runner is stopped; none by default. */
  graceMs?: number;
  /** Runs each job's model work, as the instance's per-run spend and request limits need. */
  wrap?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Days kept of finished message text, chat history and run records; kept forever when unset. */
  retentionDays?: number;
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
    await runner.stop(opts.signal?.aborted ? (opts.graceMs ?? 0) : 0);
  }
}

/** One instance a runner can cover: its store, sessions and where answers go. */
export type RunnerTarget = Pick<RunnerOptions, "store" | "sessions" | "sink" | "instance" | "wrap">;

export interface RunnersOptions
  extends Pick<RunnerOptions, "once" | "poll" | "ttl" | "workers" | "retentionDays" | "graceMs"> {
  /** The instances that should be covered now; asked again every `refresh` seconds. */
  targets: () => Promise<RunnerTarget[]>;
  /** Seconds between looks at which instances to cover. */
  refresh?: number;
  /** Stops every runner; their running jobs end interrupted. */
  signal?: AbortSignal;
}

/** How often the set of covered instances is looked at again, in seconds. */
const REFRESH_SECONDS = 30;

/** Resolves after `ms`, or sooner once `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Keeps one runner going for each instance `targets` names. The list is read again every
 * `refresh` seconds: an instance that appears gets a runner without a restart, and one that is
 * gone has its runner stopped. With `once`, each instance listed at the start runs its due work
 * once. If any runner fails, all of them stop and the failure is thrown.
 */
export async function runRunners(opts: RunnersOptions): Promise<void> {
  const shared = {
    once: opts.once,
    poll: opts.poll,
    ttl: opts.ttl,
    workers: opts.workers,
    retentionDays: opts.retentionDays,
    graceMs: opts.graceMs,
  };
  const settings = Object.fromEntries(
    Object.entries(shared).filter(([, value]) => value !== undefined),
  ) as Partial<RunnerOptions>;
  if (opts.once) {
    const targets = await opts.targets();
    await Promise.all(targets.map((target) => runRunner({ ...target, ...settings })));
    return;
  }
  const stopAll = new AbortController();
  const stop = () => stopAll.abort();
  if (opts.signal?.aborted) stop();
  opts.signal?.addEventListener("abort", stop, { once: true });
  const covered = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let failure: { error: unknown } | undefined;
  const cover = (target: RunnerTarget) => {
    const controller = new AbortController();
    const entry = {
      controller,
      done: runRunner({ ...target, ...settings, signal: controller.signal })
        .catch((error: unknown) => {
          failure ??= { error };
          stopAll.abort();
        })
        .finally(() => {
          if (covered.get(target.instance) === entry) covered.delete(target.instance);
        }),
    };
    covered.set(target.instance, entry);
  };
  try {
    let first = true;
    while (!stopAll.signal.aborted) {
      let targets: RunnerTarget[] | undefined;
      try {
        targets = await opts.targets();
      } catch (error) {
        // Without a first list there is nothing to run; a later miss keeps what is covered.
        if (first) throw error;
      }
      first = false;
      if (targets && !stopAll.signal.aborted) {
        const wanted = new Set(targets.map((target) => target.instance));
        for (const [instance, entry] of covered) {
          if (!wanted.has(instance)) entry.controller.abort();
        }
        for (const target of targets) {
          const entry = covered.get(target.instance);
          // A runner still stopping from an earlier removal is replaced once it has let go.
          if (!entry || entry.controller.signal.aborted) {
            if (entry) await entry.done;
            if (!stopAll.signal.aborted) cover(target);
          }
        }
      }
      await wait((opts.refresh ?? REFRESH_SECONDS) * 1000, stopAll.signal);
    }
  } finally {
    opts.signal?.removeEventListener("abort", stop);
    for (const entry of covered.values()) entry.controller.abort();
    await Promise.all([...covered.values()].map((entry) => entry.done));
  }
  if (failure) throw failure.error;
}

class Runner {
  private readonly store: Store;
  private readonly lease: Lease;
  private readonly owner: string;
  private readonly ttl: number;
  private readonly pollMs: number;
  private readonly active = new Map<number, Running>();
  private lost = false;
  /** When old records were last dropped, by the store clock. */
  private tidied = Number.NEGATIVE_INFINITY;

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
    await this.tidy();
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

  /** Drops what is past the retention period, at most once an hour. */
  private async tidy(): Promise<void> {
    const days = this.opts.retentionDays;
    const now = this.store.ctx.clock();
    if (!days || now - this.tidied < TIDY_SECONDS) return;
    this.tidied = now;
    try {
      await this.store.retain(days);
    } catch (error) {
      console.warn("Old records could not be dropped:", error);
    }
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

  /**
   * Gives running jobs up to `graceMs` to end, still renewing both holds, then interrupts
   * whatever still runs and gives up both holds.
   */
  async stop(graceMs = 0): Promise<void> {
    const deadline = Date.now() + graceMs;
    while (this.active.size > 0 && !this.lost && Date.now() < deadline) {
      const left = Math.min(this.pollMs, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.settled(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
      // A hold lost while waiting means another runner owns the work now.
      if (this.active.size > 0) await this.watch().catch(() => {});
    }
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
      const conversation = route;
      const work = () =>
        traced("job", () =>
          sessions.background(conversation, bot, job.task, {
            readOnly: false,
            signal: running.controller.signal,
            unattended: true,
          }),
        );
      const result = await (this.opts.wrap ? this.opts.wrap(work) : work());
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
