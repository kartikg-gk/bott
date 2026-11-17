import type { Row } from "../db/database.js";
import type { StoreContext } from "./context.js";
import { conversation, type Route } from "./routes.js";

/** Web messages take IDs above this, so they never meet IDs from any other source. */
export const WEB_IDS = 2n ** 59n;
/** Agent reports take IDs above this, above every web message. */
export const REPORT_IDS = 2n ** 60n;

export type InboxStatus =
  | "pending"
  | "scheduled"
  | "dispatching"
  | "running"
  | "delivering"
  | "cancelling"
  | "done"
  | "failed"
  | "cancelled"
  | "uncertain";

export interface InboxItem {
  id: bigint;
  chat: number;
  /** The person whose route the item belongs to. */
  user: number;
  /** The person who sent it. */
  actor: number;
  thread: number;
  text: string;
  status: InboxStatus;
  run: string | null;
}

export interface Approval {
  id: string;
  chat: number;
  user: number;
  thread: number;
  run: string;
  tool: string;
  digest: string;
  /** Seconds since the epoch. */
  expires: number;
}

export type Decision = "decided" | "expired" | "already" | "missing";

/** Statuses of items that are still waiting or in flight. */
const LIVE =
  "('pending','scheduled','dispatching','running','delivering','cancelling','uncertain')";

/** IDs are read as text, because D1 returns numbers as JSON and loses digits above 2^53. */
const ITEM =
  "CAST(id AS TEXT) AS id,chat,coalesce(route_user,user) AS route_user,user AS actor,thread," +
  "text,status,run";

const INSERT =
  "INSERT INTO inbox(instance,id,chat,user,text,status,run,created,thread,route_user) ";

function toItem(row: Row): InboxItem {
  return {
    id: BigInt(String(row.id)),
    chat: Number(row.chat),
    user: Number(row.route_user),
    actor: Number(row.actor),
    thread: Number(row.thread),
    text: row.text === null || row.text === undefined ? "" : String(row.text),
    status: String(row.status) as InboxStatus,
    run: row.run === null || row.run === undefined ? null : String(row.run),
  };
}

const byId = (a: InboxItem, b: InboxItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Queues a message from the web page on the sender's route. The next ID is taken in the
 * statement that inserts it, so two writers cannot pick the same one.
 */
export async function admitWeb(
  ctx: StoreContext,
  chat: number,
  user: number,
  text: string,
  opts: { route?: Route; run?: string } = {},
): Promise<InboxItem> {
  const { db, instance, clock } = ctx;
  const route = opts.route ?? (await conversation(ctx, chat, user));
  const run = opts.run ?? null;
  const now = clock();
  const rows = await db.query(
    `${INSERT}SELECT ?,max(coalesce((SELECT max(id) FROM inbox WHERE instance=? ` +
      "AND id>CAST(? AS INTEGER) AND id<=CAST(? AS INTEGER)),0)+1,CAST(? AS INTEGER)+1)," +
      `?,?,?,'pending',?,?,?,? RETURNING ${ITEM}`,
    [
      instance,
      instance,
      WEB_IDS,
      REPORT_IDS,
      WEB_IDS,
      chat,
      user,
      text,
      run,
      now,
      route.thread,
      route.user,
    ],
  );
  const item = toItem(rows[0] as Row);
  if (run) {
    await db.run("INSERT INTO web_runs(instance,id,inbox,bot,actor) VALUES(?,?,?,?,?)", [
      instance,
      run,
      item.id,
      route.bot,
      user,
    ]);
    await db.run(
      "INSERT INTO web_run_events(instance,run,seq,kind,data) VALUES(?,?,1,'run_queued',?)",
      [instance, run, JSON.stringify({ bot: route.bot })],
    );
  }
  await db.run(
    "INSERT INTO messages(instance,route,direction,text,platform_id,created) " +
      "VALUES(?,?,'inbound',?,?,?)",
    [instance, route.id, text, `web-${item.id}`, now],
  );
  return item;
}

/** Items waiting to be dispatched, oldest first. */
export async function pending(ctx: StoreContext): Promise<InboxItem[]> {
  const rows = await ctx.db.query(
    `SELECT ${ITEM} FROM inbox WHERE instance=? AND status='pending' ORDER BY id`,
    [ctx.instance],
  );
  return rows.map(toItem);
}

/** Items still waiting or in flight, oldest first. */
export async function items(ctx: StoreContext): Promise<InboxItem[]> {
  const rows = await ctx.db.query(
    `SELECT ${ITEM} FROM inbox WHERE instance=? AND status IN ${LIVE} ORDER BY id`,
    [ctx.instance],
  );
  return rows.map(toItem);
}

/**
 * Moves an item on from the status the caller last saw. Returns false, changing nothing, when
 * the row has moved on since; on success the item is updated to match the row.
 */
export async function mark(
  ctx: StoreContext,
  item: InboxItem,
  status: InboxStatus,
  run?: string,
): Promise<boolean> {
  const changed = await ctx.db.run(
    "UPDATE inbox SET status=?,run=coalesce(?,run),version=version+1 " +
      "WHERE instance=? AND id=? AND status=?",
    [status, run ?? null, ctx.instance, item.id, item.status],
  );
  if (changed === 0) return false;
  item.status = status;
  if (run !== undefined) item.run = run;
  return true;
}

export async function isPending(ctx: StoreContext, item: InboxItem): Promise<boolean> {
  const rows = await ctx.db.query(
    "SELECT 1 FROM inbox WHERE instance=? AND id=? AND status='pending'",
    [ctx.instance, item.id],
  );
  return rows.length > 0;
}

/** Cancels the route's items that have not started; returns how many. */
export async function clearRouteQueue(ctx: StoreContext, route: Route): Promise<number> {
  return ctx.db.run(
    "UPDATE inbox SET status='cancelled',version=version+1 WHERE instance=? AND chat=? " +
      "AND coalesce(route_user,user)=CAST(? AS INTEGER) AND thread=? AND status IN ('pending','scheduled')",
    [ctx.instance, route.chat, route.user, route.thread],
  );
}

/** Puts new text on an item and queues it again as an ordinary prompt. */
export async function replacePrompt(
  ctx: StoreContext,
  item: InboxItem,
  text: string,
): Promise<void> {
  await ctx.db.run(
    "UPDATE inbox SET text=?,status='pending',version=version+1 WHERE instance=? AND id=?",
    [text, ctx.instance, item.id],
  );
}

/** Settles the running items of one run in one conversation. */
export async function finishRun(
  ctx: StoreContext,
  chat: number,
  user: number,
  thread: number,
  run: string,
  status: InboxStatus,
): Promise<void> {
  await ctx.db.run(
    "UPDATE inbox SET status=?,version=version+1 WHERE instance=? AND chat=? " +
      "AND coalesce(route_user,user)=CAST(? AS INTEGER) AND thread=? AND run=? AND status='running'",
    [status, ctx.instance, chat, user, thread, run],
  );
}

/** Records an approval request that is waiting for a decision. */
export async function addApproval(ctx: StoreContext, a: Approval): Promise<void> {
  await ctx.db.run(
    "INSERT INTO approvals(instance,id,chat,user,thread,run,tool,digest,created,expires) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?)",
    [ctx.instance, a.id, a.chat, a.user, a.thread, a.run, a.tool, a.digest, ctx.clock(), a.expires],
  );
}

/**
 * Decides an approval that is still open and unexpired. A late or repeated decision changes
 * nothing, and the result says why.
 */
export async function decide(
  ctx: StoreContext,
  id: string,
  allow: boolean,
  source: string,
): Promise<Decision> {
  const { db, instance } = ctx;
  const now = ctx.clock();
  const changed = await db.run(
    "UPDATE approvals SET decision=?,source=?,version=version+1 WHERE instance=? AND id=? " +
      "AND decision IS NULL AND expires>?",
    [allow ? "allowed" : "denied", source, instance, id, now],
  );
  if (changed > 0) return "decided";
  const row = (
    await db.query("SELECT decision FROM approvals WHERE instance=? AND id=?", [instance, id])
  )[0];
  if (!row) return "missing";
  return row.decision === null || row.decision === undefined ? "expired" : "already";
}

/** Queues a task's report for its conversation; returns the report's inbox ID. */
export async function addReport(ctx: StoreContext, taskId: number, text: string): Promise<bigint> {
  const { db, instance, clock } = ctx;
  const task = (
    await db.query("SELECT chat,user,actor,thread FROM tasks WHERE instance=? AND id=?", [
      instance,
      taskId,
    ])
  )[0];
  if (!task) throw new Error(`No task ${taskId}`);
  const rows = await db.query(
    `${INSERT}SELECT ?,max(coalesce((SELECT max(id) FROM inbox WHERE instance=?),0)+1,` +
      "CAST(? AS INTEGER)+1),?,?,?,'pending',NULL,?,?,? RETURNING CAST(id AS TEXT) AS id",
    [
      instance,
      instance,
      REPORT_IDS,
      Number(task.chat),
      Number(task.actor),
      text,
      clock(),
      Number(task.thread),
      Number(task.user),
    ],
  );
  return BigInt(String(rows[0]?.id));
}

/**
 * Claims the reports nobody has taken yet, optionally for one chat. One statement claims them,
 * so two callers never take the same report.
 */
export async function takeUnreported(
  ctx: StoreContext,
  opts: { chat?: number } = {},
): Promise<InboxItem[]> {
  const chat = opts.chat ?? null;
  const rows = await ctx.db.query(
    "UPDATE inbox SET status='scheduled',version=version+1 WHERE instance=? " +
      "AND id>CAST(? AS INTEGER) AND status='pending' AND (? IS NULL OR chat=?) " +
      `RETURNING ${ITEM}`,
    [ctx.instance, REPORT_IDS, chat, chat],
  );
  return rows.map(toItem).sort(byId);
}
