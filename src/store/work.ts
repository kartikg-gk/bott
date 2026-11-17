import { ConstraintError, type Row } from "../db/database.js";
import type { StoreContext } from "./context.js";
import type { Route } from "./routes.js";

export interface Task {
  id: number;
  chat: number;
  user: number;
  actor: number;
  thread: number;
  bot: string;
  goal: string;
  policy: string;
  followUp: boolean;
  status: "running" | "done" | "failed" | "cancelled" | "interrupted";
  answer: string | null;
}

const COLUMNS = "id,chat,user,actor,thread,bot,goal,policy,follow_up,status,answer";

function toTask(row: Row): Task {
  return {
    id: Number(row.id),
    chat: Number(row.chat),
    user: Number(row.user),
    actor: Number(row.actor),
    thread: Number(row.thread),
    bot: String(row.bot),
    goal: String(row.goal),
    policy: String(row.policy),
    followUp: Number(row.follow_up) !== 0,
    status: String(row.status) as Task["status"],
    answer: row.answer === null || row.answer === undefined ? null : String(row.answer),
  };
}

export async function addTask(
  ctx: StoreContext,
  t: Omit<Task, "id" | "status" | "answer">,
): Promise<number> {
  const rows = await ctx.db.query(
    "INSERT INTO tasks(instance,chat,user,actor,thread,bot,goal,policy,follow_up,status,created) " +
      "VALUES(?,?,?,?,?,?,?,?,?,'running',?) RETURNING id",
    [
      ctx.instance,
      t.chat,
      t.user,
      t.actor,
      t.thread,
      t.bot,
      t.goal,
      t.policy,
      t.followUp ? 1 : 0,
      ctx.clock(),
    ],
  );
  return Number(rows[0]?.id);
}

export async function task(ctx: StoreContext, id: number): Promise<Task | null> {
  const rows = await ctx.db.query(`SELECT ${COLUMNS} FROM tasks WHERE instance=? AND id=?`, [
    ctx.instance,
    id,
  ]);
  return rows[0] ? toTask(rows[0]) : null;
}

export async function tasks(ctx: StoreContext, limit = 20): Promise<Task[]> {
  const rows = await ctx.db.query(
    `SELECT ${COLUMNS} FROM tasks WHERE instance=? ORDER BY id DESC LIMIT ?`,
    [ctx.instance, limit],
  );
  return rows.map(toTask);
}

export async function runningTasks(ctx: StoreContext): Promise<Task[]> {
  const rows = await ctx.db.query(
    `SELECT ${COLUMNS} FROM tasks WHERE instance=? AND status='running' ORDER BY id DESC`,
    [ctx.instance],
  );
  return rows.map(toTask);
}

/** Settles a running task and marks it reported; a task that already ended is left alone. */
export async function finishTask(
  ctx: StoreContext,
  id: number,
  status: Task["status"],
  answer: string | null,
): Promise<boolean> {
  const changed = await ctx.db.run(
    "UPDATE tasks SET status=?,answer=?,finished=?,reported=1 " +
      "WHERE instance=? AND id=? AND status='running'",
    [status, answer, ctx.clock(), ctx.instance, id],
  );
  return changed > 0;
}

/**
 * Starts a delegation unless the bot already has one running. The check and the insert are one
 * statement, and a unique index backs it up when two writers race.
 */
export async function beginDelegation(
  ctx: StoreContext,
  route: Route,
  bot: string,
  text: string,
): Promise<number | null> {
  try {
    const rows = await ctx.db.query(
      "INSERT INTO delegations(instance,route,bot,task,status,created) " +
        "SELECT ?,?,?,?,'running',? WHERE NOT EXISTS " +
        "(SELECT 1 FROM delegations WHERE instance=? AND bot=? AND status='running') " +
        "RETURNING id",
      [ctx.instance, route.id, bot, text, ctx.clock(), ctx.instance, bot],
    );
    return rows[0] ? Number(rows[0].id) : null;
  } catch (error) {
    if (error instanceof ConstraintError) return null;
    throw error;
  }
}

export async function finishDelegation(
  ctx: StoreContext,
  id: number,
  status: string,
  answer: string | null,
): Promise<boolean> {
  const changed = await ctx.db.run(
    "UPDATE delegations SET status=?,answer=?,finished=?,version=version+1 " +
      "WHERE instance=? AND id=? AND status='running'",
    [status, answer, ctx.clock(), ctx.instance, id],
  );
  return changed > 0;
}
