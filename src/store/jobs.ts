import type { Param, Row } from "../db/database.js";
import type { StoreContext } from "./context.js";

/** How many active or paused jobs one person may keep. */
export const MAX_ACTIVE_JOBS = 50;
/** Seconds a run may be late before a job set to skip missed runs gives that run up. */
export const MISSED_GRACE = 300;

export interface Job {
  id: number;
  chat: number;
  user: number;
  actor: number;
  thread: number;
  bot: string;
  task: string;
  spec: string;
  nextRun: number | null;
  missed: "run" | "skip";
  status: "active" | "paused" | "cancelled" | "done";
  running: boolean;
  /** How the last run ended, for example completed, failed, interrupted or missed. */
  lastStatus: string | null;
  lastRun: number | null;
  lastAnswer: string | null;
}

export interface NewJob {
  chat: number;
  user: number;
  actor: number;
  thread: number;
  bot: string;
  task: string;
  spec: string;
  /** When the job first runs; null for jobs that only wake on events. */
  first: number | null;
  missed?: "run" | "skip";
}

export interface JobChanges {
  bot?: string;
  task?: string;
  /** A new schedule; `first` then sets its next run. */
  spec?: string;
  first?: number | null;
  missed?: "run" | "skip";
}

/** Gives a job's next run after a time, or null when it does not repeat. */
export type NextRun = (spec: string, after: number) => number | null;

const COLUMNS =
  "id,chat,user,actor,thread,bot,task,spec,next_run,missed,status,running,last_status," +
  "last_run,last_answer";
const LIVE = "status IN ('active','paused')";
const EVENT_PREFIX = "event:";

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

function toJob(row: Row): Job {
  return {
    id: Number(row.id),
    chat: Number(row.chat),
    user: Number(row.user),
    actor: Number(row.actor),
    thread: Number(row.thread),
    bot: String(row.bot),
    task: String(row.task),
    spec: String(row.spec),
    nextRun: num(row.next_run),
    missed: String(row.missed) as Job["missed"],
    status: String(row.status) as Job["status"],
    running: Number(row.running) !== 0,
    lastStatus: text(row.last_status),
    lastRun: num(row.last_run),
    lastAnswer: text(row.last_answer),
  };
}

function checkMissed(missed: string | undefined): void {
  if (missed !== undefined && missed !== "run" && missed !== "skip") {
    throw new Error("Missed jobs can be run or skipped");
  }
}

/** Adds a job unless its owner is at the quota. The count and the insert are one statement. */
export async function addJob(ctx: StoreContext, j: NewJob): Promise<number> {
  checkMissed(j.missed);
  const rows = await ctx.db.query(
    "INSERT INTO jobs(instance,chat,user,actor,thread,bot,task,spec,next_run,missed,created) " +
      "SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM jobs " +
      `WHERE instance=? AND actor=? AND ${LIVE}) < CAST(? AS INTEGER) RETURNING id`,
    [
      ctx.instance,
      j.chat,
      j.user,
      j.actor,
      j.thread,
      j.bot,
      j.task,
      j.spec,
      j.first,
      j.missed ?? "run",
      ctx.clock(),
      ctx.instance,
      j.actor,
      MAX_ACTIVE_JOBS,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error(`There are already ${MAX_ACTIVE_JOBS} active jobs`);
  return Number(row.id);
}

export async function job(ctx: StoreContext, id: number): Promise<Job | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const rows = await ctx.db.query(`SELECT ${COLUMNS} FROM jobs WHERE instance=? AND id=?`, [
    ctx.instance,
    id,
  ]);
  return rows[0] ? toJob(rows[0]) : null;
}

/** Live and running jobs first, newest first; finished ones only with `history`. At most 100. */
export async function jobs(
  ctx: StoreContext,
  opts: { actor?: number; bot?: string; history?: boolean } = {},
): Promise<Job[]> {
  const where = ["instance=?"];
  const params: Param[] = [ctx.instance];
  if (opts.actor !== undefined) {
    where.push("actor=?");
    params.push(opts.actor);
  }
  if (opts.bot !== undefined) {
    where.push("bot=?");
    params.push(opts.bot);
  }
  if (!opts.history) where.push(`(${LIVE} OR running=1)`);
  const rows = await ctx.db.query(
    `SELECT ${COLUMNS} FROM jobs WHERE ${where.join(" AND ")} ` +
      `ORDER BY CASE WHEN ${LIVE} OR running=1 THEN 0 ELSE 1 END, id DESC LIMIT 100`,
    params,
  );
  return rows.map(toJob);
}

async function automationOn(ctx: StoreContext): Promise<boolean> {
  const rows = await ctx.db.query("SELECT enabled FROM job_automation WHERE instance=?", [
    ctx.instance,
  ]);
  return rows[0] ? Number(rows[0].enabled) !== 0 : true;
}

/**
 * Claims the jobs due at `now` for the scheduler `owner` and marks them running. Each claim is
 * one UPDATE that only lands on the version this call read, and only while `owner` holds the live
 * scheduler row, so two processes never both claim a job and recovery elsewhere leaves claimed
 * jobs alone. The claim also moves a scheduled job to the time `next` gives, or ends it when
 * `next` gives null, so a run cut short by a crash is not run again. A busy bot gets no job, and
 * each bot gets at most one per call. A job set to skip missed runs that is more than
 * MISSED_GRACE late is not run: it moves on and records the miss.
 */
export async function claimDue(
  ctx: StoreContext,
  now: number,
  opts: { owner: string; next: NextRun; chat?: number; busyBots?: string[] },
): Promise<Job[]> {
  if (!(await automationOn(ctx))) return [];
  const { db, instance } = ctx;
  const params: Param[] = [instance];
  let chat = "";
  if (opts.chat !== undefined) {
    chat = " AND chat=?";
    params.push(opts.chat);
  }
  params.push(now);
  const rows = await db.query(
    `SELECT ${COLUMNS},version FROM jobs WHERE instance=? AND status='active' AND running=0` +
      `${chat} AND (next_run<=? OR EXISTS (SELECT 1 FROM job_wakeups ` +
      "WHERE job_wakeups.instance=jobs.instance AND job_wakeups.job=jobs.id " +
      "AND job_wakeups.status='queued')) ORDER BY id",
    params,
  );
  const busy = new Set(opts.busyBots ?? []);
  const guard =
    "WHERE instance=? AND id=? AND version=? AND running=0 AND status='active' AND EXISTS " +
    "(SELECT 1 FROM scheduler_leases WHERE instance=? AND owner=? AND expires>?)";
  const claimed: Job[] = [];
  for (const row of rows) {
    const found = toJob(row);
    if (busy.has(found.bot)) continue;
    const key: Param[] = [instance, found.id, Number(row.version), instance, opts.owner, now];
    if (found.spec.startsWith(EVENT_PREFIX)) {
      const taken = await db.run(
        `UPDATE jobs SET running=1,last_run=?,version=version+1 ${guard}`,
        [now, ...key],
      );
      if (taken === 0) continue;
      await db.run(
        "UPDATE job_wakeups SET status='running',claimed=? WHERE id=(SELECT id FROM job_wakeups " +
          "WHERE instance=? AND job=? AND status='queued' ORDER BY id LIMIT 1)",
        [now, instance, found.id],
      );
      claimed.push({ ...found, running: true, lastRun: now });
      busy.add(found.bot);
      continue;
    }
    const upcoming = opts.next(found.spec, now);
    const status = upcoming === null ? "done" : "active";
    const late = found.nextRun !== null && now - found.nextRun > MISSED_GRACE;
    if (found.missed === "skip" && late) {
      await db.run(
        "UPDATE jobs SET next_run=?,status=?,last_status='missed',last_answer=NULL," +
          `version=version+1 ${guard}`,
        [upcoming, status, ...key],
      );
      continue;
    }
    const taken = await db.run(
      `UPDATE jobs SET next_run=?,status=?,running=1,last_run=?,version=version+1 ${guard}`,
      [upcoming, status, now, ...key],
    );
    if (taken === 0) continue;
    claimed.push({ ...found, nextRun: upcoming, status, running: true, lastRun: now });
    busy.add(found.bot);
  }
  return claimed;
}

/**
 * Records how a run ended. With `claimedAt`, only the claim made at that time is finished, so a
 * late finish from an earlier claim changes nothing. A `next` time moves the job on; null ends a
 * job that does not repeat.
 */
export async function finishJob(
  ctx: StoreContext,
  id: number,
  status: string,
  answer: string | null = null,
  opts: { claimedAt?: number; next?: number | null } = {},
): Promise<boolean> {
  const sets = ["running=0", "last_status=?", "last_answer=?", "version=version+1"];
  const params: Param[] = [status, answer];
  if (opts.next !== undefined) {
    sets.push("next_run=CASE WHEN status='active' THEN ? ELSE next_run END");
    sets.push("status=CASE WHEN status='active' AND ? IS NULL THEN 'done' ELSE status END");
    params.push(opts.next, opts.next);
  }
  let where = "WHERE instance=? AND id=?";
  params.push(ctx.instance, id);
  if (opts.claimedAt !== undefined) {
    where += " AND running=1 AND last_run=?";
    params.push(opts.claimedAt);
  }
  const changed = await ctx.db.run(`UPDATE jobs SET ${sets.join(",")} ${where}`, params);
  if (changed === 0) return false;
  if (opts.claimedAt !== undefined) {
    await ctx.db.run(
      "UPDATE job_wakeups SET status=?,finished=? WHERE instance=? AND job=? AND claimed=? " +
        "AND status='running'",
      [status, ctx.clock(), ctx.instance, id, opts.claimedAt],
    );
  }
  return true;
}

/**
 * Hands back a claim whose run never started, so the job waits for a later claim and records no
 * run. Only the claim made at `claimedAt` is handed back. The job is due again at `due`, a one-off
 * the claim ended is live again, and an event job's wake-up goes back in the queue. A job
 * cancelled meanwhile stays cancelled.
 */
export async function releaseJob(
  ctx: StoreContext,
  id: number,
  claimedAt: number,
  due: number | null,
): Promise<boolean> {
  const changed = await ctx.db.run(
    "UPDATE jobs SET running=0,next_run=CASE WHEN status='cancelled' THEN next_run ELSE ? END," +
      "status=CASE WHEN status='done' THEN 'active' ELSE status END,version=version+1 " +
      "WHERE instance=? AND id=? AND running=1 AND last_run=?",
    [due, ctx.instance, id, claimedAt],
  );
  if (changed === 0) return false;
  await ctx.db.run(
    "UPDATE job_wakeups SET status='queued',claimed=NULL WHERE instance=? AND job=? " +
      "AND claimed=? AND status='running'",
    [ctx.instance, id, claimedAt],
  );
  return true;
}

export async function setJobPaused(
  ctx: StoreContext,
  id: number,
  actor: number,
  paused: boolean,
): Promise<boolean> {
  const [from, to] = paused ? ["active", "paused"] : ["paused", "active"];
  const changed = await ctx.db.run(
    "UPDATE jobs SET status=?,version=version+1 WHERE instance=? AND id=? AND actor=? AND status=?",
    [to, ctx.instance, id, actor, from],
  );
  return changed > 0;
}

/** Changes an idle live job its owner asks to change. A new spec takes `first` as its next run. */
export async function editJob(
  ctx: StoreContext,
  id: number,
  actor: number,
  fields: JobChanges,
): Promise<boolean> {
  checkMissed(fields.missed);
  const sets = ["version=version+1"];
  const params: Param[] = [];
  for (const [column, value] of [
    ["bot", fields.bot],
    ["task", fields.task],
    ["missed", fields.missed],
  ] as const) {
    if (value === undefined) continue;
    sets.push(`${column}=?`);
    params.push(value);
  }
  if (fields.spec !== undefined) {
    sets.push("spec=?", "next_run=?");
    params.push(fields.spec, fields.first ?? null);
  }
  const changed = await ctx.db.run(
    `UPDATE jobs SET ${sets.join(",")} WHERE instance=? AND id=? AND actor=? AND ${LIVE} ` +
      "AND running=0",
    [...params, ctx.instance, id, actor],
  );
  return changed > 0;
}

/** Cancels a live or running job; with `actor`, only that person's. */
export async function cancelJob(ctx: StoreContext, id: number, actor?: number): Promise<boolean> {
  const params: Param[] = [ctx.instance, id];
  let owner = "";
  if (actor !== undefined) {
    owner = " AND actor=?";
    params.push(actor);
  }
  const changed = await ctx.db.run(
    "UPDATE jobs SET status='cancelled',next_run=NULL,version=version+1 " +
      `WHERE instance=? AND id=?${owner} AND (${LIVE} OR running=1)`,
    params,
  );
  return changed > 0;
}

/**
 * Takes or renews the instance's scheduler row for `owner`, so recovery in other processes
 * leaves this owner's running jobs alone. False while another owner's row is live. Taking over
 * from an owner whose row ran out interrupts the jobs it left running.
 */
export async function holdScheduler(
  ctx: StoreContext,
  owner: string,
  ttlSeconds: number,
): Promise<boolean> {
  const { db, instance } = ctx;
  const now = ctx.clock();
  const expires = now + ttlSeconds;
  const inserted = await db.run(
    "INSERT INTO scheduler_leases(instance,owner,heartbeat,expires) VALUES(?,?,?,?) " +
      "ON CONFLICT(instance) DO NOTHING",
    [instance, owner, now, expires],
  );
  if (inserted > 0) return true;
  const current = (
    await db.query("SELECT owner,expires,version FROM scheduler_leases WHERE instance=?", [
      instance,
    ])
  )[0];
  if (!current) return false;
  const previous = String(current.owner);
  if (previous !== owner && Number(current.expires) > now) return false;
  const taken = await db.run(
    "UPDATE scheduler_leases SET owner=?,heartbeat=?,expires=?,version=version+1 " +
      "WHERE instance=? AND version=?",
    [owner, now, expires, instance, Number(current.version)],
  );
  if (taken === 0) return false;
  if (previous !== owner) {
    await db.run(
      "UPDATE jobs SET running=0,last_status='interrupted',last_answer=NULL,version=version+1 " +
        "WHERE instance=? AND running=1",
      [instance],
    );
    await db.run(
      "UPDATE job_wakeups SET status='interrupted',finished=? WHERE instance=? " +
        "AND status='running' AND NOT EXISTS (SELECT 1 FROM jobs WHERE " +
        "jobs.instance=job_wakeups.instance AND jobs.id=job_wakeups.job AND jobs.running=1 " +
        "AND jobs.last_run=job_wakeups.claimed)",
      [now, instance],
    );
  }
  return true;
}

export async function releaseScheduler(ctx: StoreContext, owner: string): Promise<void> {
  await ctx.db.run("DELETE FROM scheduler_leases WHERE instance=? AND owner=?", [
    ctx.instance,
    owner,
  ]);
}
