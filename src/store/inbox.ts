import type { Row } from "../db/database.js";
import type { StoreContext } from "./context.js";
import { conversation, type Route } from "./routes.js";

/** The chat every web conversation is filed under, as existing databases hold it. */
export const WEB_CHAT = 2 ** 52;
/** Web messages take IDs above this, so they never meet IDs from any other source. */
export const WEB_IDS = 2n ** 59n;
/** Agent reports take IDs above this, above every web message. */
export const REPORT_IDS = 2n ** 60n;

/**
 * Where an inbox item stands. These strings are what existing databases hold, so they stay.
 * Waiting: `pending` (a message, which may be a command), `prompt` (text that is always a
 * prompt, never a command) and `rejected` (a message to answer with a refusal).
 */
export type InboxStatus =
  | "pending"
  | "prompt"
  | "rejected"
  | "scheduled"
  | "dispatching"
  | "running"
  | "delivering"
  | "cancelling"
  | "completed"
  | "stopped"
  | "failed"
  | "delivery_failed"
  | "uncertain"
  | "cancelled"
  | "dismissed"
  | "rejected_done";

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

/** A notice owed to a conversation whose task was interrupted. */
export interface TaskNotice {
  task: number;
  chat: number;
  user: number;
  actor: number;
  thread: number;
  text: string;
}

/** Statuses of items waiting to be dispatched. */
const WAITING = "('pending','prompt','rejected')";

/** Commands whose argument is a prompt, so clearing a queue cancels them like prompts. */
const PROMPT_COMMANDS = ["/queue ", "/steer "];

/**
 * IDs are read as text, because D1 returns numbers as JSON and loses digits above 2^53. Sort
 * by `inbox.id`, since a bare `id` would sort the text alias.
 */
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
      `?,?,?,?,?,?,?,? RETURNING ${ITEM}`,
    [
      instance,
      instance,
      WEB_IDS,
      REPORT_IDS,
      WEB_IDS,
      chat,
      user,
      text,
      run ? "prompt" : "pending",
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

/** Items waiting to be dispatched, oldest first. Nothing already dispatched is listed. */
export async function items(ctx: StoreContext): Promise<InboxItem[]> {
  const rows = await ctx.db.query(
    `SELECT ${ITEM} FROM inbox WHERE instance=? AND status IN ${WAITING} ORDER BY inbox.id`,
    [ctx.instance],
  );
  return rows.map(toItem);
}

/** The same items as `items`. */
export function pending(ctx: StoreContext): Promise<InboxItem[]> {
  return items(ctx);
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
    `SELECT 1 FROM inbox WHERE instance=? AND id=? AND status IN ${WAITING}`,
    [ctx.instance, item.id],
  );
  return rows.length > 0;
}

/**
 * Cancels the route's queued prompts that have not started; returns how many. Queued commands
 * stay, except those that carry a prompt.
 */
export async function clearRouteQueue(ctx: StoreContext, route: Route): Promise<number> {
  const carried = PROMPT_COMMANDS.map(() => " OR text LIKE ?").join("");
  return ctx.db.run(
    "UPDATE inbox SET status='cancelled',version=version+1 WHERE instance=? AND chat=? " +
      "AND coalesce(route_user,user)=CAST(? AS INTEGER) AND thread=? " +
      "AND status IN ('pending','prompt','scheduled') " +
      `AND (status IN ('prompt','scheduled') OR text NOT LIKE '/%'${carried})`,
    [
      ctx.instance,
      route.chat,
      route.user,
      route.thread,
      ...PROMPT_COMMANDS.map((command) => `${command}%`),
    ],
  );
}

/** Puts new text on an item and queues it again as a prompt, never read as a command. */
export async function replacePrompt(
  ctx: StoreContext,
  item: InboxItem,
  text: string,
): Promise<void> {
  await ctx.db.run(
    "UPDATE inbox SET text=?,status='prompt',version=version+1 WHERE instance=? AND id=?",
    [text, ctx.instance, item.id],
  );
  // `mark` checks the status it is given, so the caller's copy must follow the row.
  item.text = text;
  item.status = "prompt";
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
 * nothing, and the result says why. With `user`, only that person's approval is decided; anyone
 * else's counts as missing.
 */
export async function decide(
  ctx: StoreContext,
  id: string,
  allow: boolean,
  source: string,
  user?: number,
): Promise<Decision> {
  const { db, instance } = ctx;
  const now = ctx.clock();
  const asked = user === undefined ? "" : " AND user=?";
  const whose = user === undefined ? [] : [user];
  const changed = await db.run(
    "UPDATE approvals SET decision=?,source=?,version=version+1 WHERE instance=? AND id=? " +
      `AND decision IS NULL AND expires>?${asked}`,
    [allow ? "allowed" : "denied", source, instance, id, now, ...whose],
  );
  if (changed > 0) return "decided";
  const row = (
    await db.query(`SELECT decision FROM approvals WHERE instance=? AND id=?${asked}`, [
      instance,
      id,
      ...whose,
    ])
  )[0];
  if (!row) return "missing";
  return row.decision === null || row.decision === undefined ? "expired" : "already";
}

/** The approvals among `ids` that have been decided, each mapped to whether it was allowed. */
export async function decisions(ctx: StoreContext, ids: string[]): Promise<Map<string, boolean>> {
  const found = new Map<string, boolean>();
  if (ids.length === 0) return found;
  const rows = await ctx.db.query(
    `SELECT id,decision FROM approvals WHERE instance=? AND id IN (${ids.map(() => "?").join(",")}) ` +
      "AND decision IS NOT NULL",
    [ctx.instance, ...ids],
  );
  for (const row of rows) found.set(String(row.id), row.decision === "allowed");
  return found;
}

/** An approval still waiting for a decision, as the database holds it. */
export interface OpenApproval {
  id: string;
  chat: number;
  thread: number;
  tool: string;
  digest: string;
  /** Seconds since the epoch. */
  expires: number;
}

/**
 * The person's approvals that are undecided and unexpired, oldest first. Only those whose
 * conversation still has a message or a background task going are listed: an approval left by
 * a process that stopped has nobody waiting for its answer.
 */
export async function openApprovals(ctx: StoreContext, user: number): Promise<OpenApproval[]> {
  const rows = await ctx.db.query(
    "SELECT id,chat,thread,tool,digest,expires FROM approvals a WHERE instance=? AND user=? " +
      "AND decision IS NULL AND expires>? AND (EXISTS (SELECT 1 FROM inbox i " +
      "WHERE i.instance=a.instance AND i.chat=a.chat AND i.user=a.user AND i.thread=a.thread " +
      "AND i.status IN ('dispatching','running')) OR EXISTS (SELECT 1 FROM tasks t " +
      "WHERE t.instance=a.instance AND t.chat=a.chat AND t.actor=a.user AND t.thread=a.thread " +
      "AND t.status='running')) ORDER BY created,id",
    [ctx.instance, user, ctx.clock()],
  );
  return rows.map((row) => ({
    id: String(row.id),
    chat: Number(row.chat),
    thread: Number(row.thread),
    tool: String(row.tool),
    digest: String(row.digest),
    expires: Number(row.expires),
  }));
}

/** The current status of each of these inbox items that still exists. */
export async function statuses(ctx: StoreContext, ids: bigint[]): Promise<Map<bigint, string>> {
  const found = new Map<bigint, string>();
  if (ids.length === 0) return found;
  const rows = await ctx.db.query(
    `SELECT CAST(id AS TEXT) AS id,status FROM inbox WHERE instance=? AND id IN (${ids.map(() => "?").join(",")})`,
    [ctx.instance, ...ids],
  );
  for (const row of rows) found.set(BigInt(String(row.id)), String(row.status));
  return found;
}

/**
 * Queues a task's report as a prompt for its conversation, and marks the task reported so it
 * is not also announced as interrupted. Returns the report's inbox ID.
 */
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
      "CAST(? AS INTEGER)+1),?,?,?,'prompt',NULL,?,?,? RETURNING CAST(id AS TEXT) AS id",
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
  await db.run("UPDATE tasks SET reported=1 WHERE instance=? AND id=?", [instance, taskId]);
  return BigInt(String(rows[0]?.id));
}

/**
 * Claims the interrupted tasks nobody has been told about, optionally for one chat, and
 * returns a notice for each. One statement claims them, so each is announced once.
 */
export async function takeUnreported(
  ctx: StoreContext,
  opts: { chat?: number } = {},
): Promise<TaskNotice[]> {
  const chat = opts.chat ?? null;
  const rows = await ctx.db.query(
    "UPDATE tasks SET reported=1 WHERE instance=? AND status='interrupted' AND reported=0 " +
      "AND (? IS NULL OR chat=?) RETURNING id,chat,user,actor,thread",
    [ctx.instance, chat, chat],
  );
  return rows
    .map((row) => ({
      task: Number(row.id),
      chat: Number(row.chat),
      user: Number(row.user),
      actor: Number(row.actor),
      thread: Number(row.thread),
      text: `Task #${row.id} was interrupted and not replayed.`,
    }))
    .sort((a, b) => a.task - b.task);
}
