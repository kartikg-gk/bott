import { randomUUID } from "node:crypto";
import * as bots from "../bots/bots.js";
import type { Database } from "../db/database.js";
import { ensureSchema } from "../db/schema.js";
import type { StoreContext } from "./context.js";
import * as inbox from "./inbox.js";
import * as jobs from "./jobs.js";
import { recoveryStatements } from "./recovery.js";
import * as routes from "./routes.js";
import * as work from "./work.js";

const CHIEF_NAME = "Chief of Staff";
const CHIEF_ROLE = "The main bot for this person.";
const APPROVAL_DAYS = 30;
const DAY = 86400;

export type { Bot, BotChanges } from "../bots/bots.js";
export type { Approval, Decision, InboxItem, InboxStatus, TaskNotice } from "./inbox.js";
export { REPORT_IDS, WEB_CHAT, WEB_IDS } from "./inbox.js";
export type { ClaimedJob, Job, JobChanges, NewJob, NextRun } from "./jobs.js";
export { MAX_ACTIVE_JOBS, MISSED_GRACE } from "./jobs.js";
export type { Route } from "./routes.js";
export type { DelegationStatus, Task, WorkStatus } from "./work.js";

export interface StoreOptions {
  retentionDays?: number;
  /**
   * Settle work a stopped process left while opening. Off unless asked: only the process that
   * holds the runner lease and the scheduler row should recover, and it can instead call
   * `recover()` once it holds both. Any other opener would interrupt live work.
   */
  recover?: boolean;
  /** Seconds since the epoch, as a float. */
  clock?: () => number;
}

export class Store {
  private constructor(
    readonly ctx: StoreContext,
    private readonly retentionDays: number | undefined,
  ) {}

  /**
   * Opens the store on any database and makes sure the instance has one chief. Unfinished work is
   * left alone unless `recover: true` is passed.
   */
  static async open(db: Database, instance: string, opts: StoreOptions = {}): Promise<Store> {
    const clock = opts.clock ?? (() => Date.now() / 1000);
    const store = new Store({ db, instance, clock }, opts.retentionDays);
    await ensureSchema(db);
    await db.run("INSERT OR IGNORE INTO instances(id) VALUES (?)", [instance]);
    if (opts.recover === true) await store.recover();
    await db.run(
      "INSERT INTO bots(id,instance,name,name_key,role,chief,created) " +
        "SELECT ?,?,?,?,?,1,? WHERE NOT EXISTS (SELECT 1 FROM bots WHERE instance=? AND chief=1)",
      [
        randomUUID().replaceAll("-", ""),
        instance,
        CHIEF_NAME,
        CHIEF_NAME.toLowerCase(),
        CHIEF_ROLE,
        clock(),
        instance,
      ],
    );
    return store;
  }

  async chief(): Promise<{ id: string; name: string }> {
    const { db, instance } = this.ctx;
    const rows = await db.query("SELECT id,name FROM bots WHERE instance=? AND chief=1", [
      instance,
    ]);
    const row = rows[0];
    if (!row) throw new Error("The instance has no chief bot");
    return { id: String(row.id), name: String(row.name) };
  }

  bots(opts?: { temporary?: boolean }) {
    return bots.bots(this.ctx, opts);
  }

  bot(id: string) {
    return bots.bot(this.ctx, id);
  }

  findBot(nameOrId: string) {
    return bots.findBot(this.ctx, nameOrId);
  }

  createBot(input: { name: string; role: string; instructions?: string; temporary?: boolean }) {
    return bots.createBot(this.ctx, input);
  }

  updateBot(id: string, fields: bots.BotChanges) {
    return bots.updateBot(this.ctx, id, fields);
  }

  keepBot(id: string) {
    return bots.keepBot(this.ctx, id);
  }

  removeBot(id: string) {
    return bots.removeBot(this.ctx, id);
  }

  pluginsFor(botId: string) {
    return bots.pluginsFor(this.ctx, botId);
  }

  setPlugin(botId: string, plugin: string, on: boolean) {
    return bots.setPlugin(this.ctx, botId, plugin, on);
  }

  conversation(chat: number, user: number, thread = 0) {
    return routes.conversation(this.ctx, chat, user, thread);
  }

  getRoute(id: number) {
    return routes.getRoute(this.ctx, id);
  }

  listRoutes(actor: number, opts?: { groups?: boolean }) {
    return routes.listRoutes(this.ctx, actor, opts);
  }

  persistRoute(route: routes.Route, state: Partial<routes.Route>) {
    return routes.persistRoute(this.ctx, route, state);
  }

  point(route: routes.Route, source: routes.Route) {
    return routes.point(this.ctx, route, source);
  }

  switchBot(route: routes.Route, botId: string) {
    return routes.switchBot(this.ctx, route, botId);
  }

  owns(chat: number, user: number, thread: number, session: string) {
    return routes.owns(this.ctx, chat, user, thread, session);
  }

  remember(chat: number, user: number, thread: number, details: routes.SessionDetails) {
    return routes.remember(this.ctx, chat, user, thread, details);
  }

  saved(session: string) {
    return routes.saved(this.ctx, session);
  }

  sessions(chat: number, user: number, thread = 0, offset = 0) {
    return routes.sessions(this.ctx, chat, user, thread, offset);
  }

  logMessage(route: routes.Route, body: string, direction: "in" | "out") {
    return routes.logMessage(this.ctx, route, body, direction);
  }

  history(chat: number, user: number, limit = 100) {
    return routes.history(this.ctx, chat, user, limit);
  }

  admitWeb(
    chat: number,
    user: number,
    text: string,
    opts?: { route?: routes.Route; run?: string },
  ) {
    return inbox.admitWeb(this.ctx, chat, user, text, opts);
  }

  pending() {
    return inbox.pending(this.ctx);
  }

  mark(item: inbox.InboxItem, status: inbox.InboxStatus, run?: string) {
    return inbox.mark(this.ctx, item, status, run);
  }

  isPending(item: inbox.InboxItem) {
    return inbox.isPending(this.ctx, item);
  }

  items() {
    return inbox.items(this.ctx);
  }

  clearRouteQueue(route: routes.Route) {
    return inbox.clearRouteQueue(this.ctx, route);
  }

  replacePrompt(item: inbox.InboxItem, text: string) {
    return inbox.replacePrompt(this.ctx, item, text);
  }

  finishRun(chat: number, user: number, thread: number, run: string, status: inbox.InboxStatus) {
    return inbox.finishRun(this.ctx, chat, user, thread, run, status);
  }

  addApproval(a: inbox.Approval) {
    return inbox.addApproval(this.ctx, a);
  }

  decide(id: string, allow: boolean, source: string) {
    return inbox.decide(this.ctx, id, allow, source);
  }

  addReport(taskId: number, text: string) {
    return inbox.addReport(this.ctx, taskId, text);
  }

  takeUnreported(opts?: { chat?: number }) {
    return inbox.takeUnreported(this.ctx, opts);
  }

  addTask(t: Omit<work.Task, "id" | "status" | "answer">) {
    return work.addTask(this.ctx, t);
  }

  task(id: number) {
    return work.task(this.ctx, id);
  }

  tasks(limit = 20) {
    return work.tasks(this.ctx, limit);
  }

  runningTasks() {
    return work.runningTasks(this.ctx);
  }

  finishTask(id: number, status: work.WorkStatus, answer: string | null) {
    return work.finishTask(this.ctx, id, status, answer);
  }

  beginDelegation(route: routes.Route, bot: string, task: string) {
    return work.beginDelegation(this.ctx, route, bot, task);
  }

  finishDelegation(id: number, status: work.DelegationStatus, answer: string | null) {
    return work.finishDelegation(this.ctx, id, status, answer);
  }

  dropDelegation(id: number) {
    return work.dropDelegation(this.ctx, id);
  }

  addJob(j: jobs.NewJob) {
    return jobs.addJob(this.ctx, j);
  }

  job(id: number) {
    return jobs.job(this.ctx, id);
  }

  jobs(opts?: { actor?: number; bot?: string; history?: boolean }) {
    return jobs.jobs(this.ctx, opts);
  }

  claimDue(
    now: number,
    opts: {
      owner: string;
      next: jobs.NextRun;
      chat?: number;
      busyBots?: string[];
      limit?: number;
    },
  ) {
    return jobs.claimDue(this.ctx, now, opts);
  }

  finishJob(
    id: number,
    status: string,
    answer?: string | null,
    opts?: { claimedAt?: number; next?: number | null },
  ) {
    return jobs.finishJob(this.ctx, id, status, answer ?? null, opts);
  }

  releaseJob(job: jobs.ClaimedJob) {
    return jobs.releaseJob(this.ctx, job);
  }

  setJobPaused(id: number, actor: number, paused: boolean) {
    return jobs.setJobPaused(this.ctx, id, actor, paused);
  }

  editJob(id: number, actor: number, fields: jobs.JobChanges) {
    return jobs.editJob(this.ctx, id, actor, fields);
  }

  cancelJob(id: number, actor?: number) {
    return jobs.cancelJob(this.ctx, id, actor);
  }

  /** Mirrors the runner's lease into the scheduler row that recovery checks; call on renewal. */
  holdScheduler(owner: string, ttlSeconds: number) {
    return jobs.holdScheduler(this.ctx, owner, ttlSeconds);
  }

  releaseScheduler(owner: string) {
    return jobs.releaseScheduler(this.ctx, owner);
  }

  /**
   * Settles inbox items, tasks, delegations, approvals and (when no scheduler lease is live) jobs
   * that a stopped process left unfinished. Call only while holding the runner lease.
   */
  async recover(): Promise<void> {
    const { db, instance, clock } = this.ctx;
    for (const [sql, params] of recoveryStatements(instance, clock())) await db.run(sql, params);
  }

  /** Drops text and rows older than the retention period; returns how many rows changed. */
  async retain(days?: number): Promise<number> {
    const keep = days ?? this.retentionDays;
    if (!keep) return 0;
    const { db, instance, clock } = this.ctx;
    const now = clock();
    const cutoff = now - keep * DAY;
    let changed = 0;
    changed += await db.run(
      "UPDATE inbox SET text=NULL WHERE instance=? AND created<? AND text IS NOT NULL " +
        "AND status IN ('completed','cancelled','dismissed','rejected_done')",
      [instance, cutoff],
    );
    changed += await db.run(
      "DELETE FROM approvals WHERE instance=? AND created<? AND decision IS NOT NULL",
      [instance, now - APPROVAL_DAYS * DAY],
    );
    changed += await db.run("DELETE FROM web_runs WHERE instance=? AND finished<?", [
      instance,
      cutoff,
    ]);
    changed += await db.run("DELETE FROM messages WHERE instance=? AND created<?", [
      instance,
      cutoff,
    ]);
    return changed;
  }
}
