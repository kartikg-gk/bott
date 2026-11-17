import type { Param, Row } from "../db/database.js";
import type { StoreContext } from "./context.js";

export interface Route {
  id: number;
  chat: number;
  user: number;
  thread: number;
  bot: string | null;
  session: string | null;
  sessionFile: string | null;
  title: string | null;
  provider: string | null;
  model: string | null;
  thinking: string | null;
  created: number;
  updated: number;
}

export interface SessionDetails {
  session: string;
  sessionFile: string | null;
  title?: string | null;
  provider?: string | null;
  model?: string | null;
  thinking?: string | null;
}

export interface LoggedMessage {
  direction: "in" | "out";
  text: string;
  created: number;
}

const LIST_LIMIT = 10;
const PAGE = 21;

/** Columns a route holds for whichever session it is pointed at. */
const SESSION_FIELDS = [
  ["session", "session"],
  ["sessionFile", "session_file"],
  ["title", "title"],
  ["provider", "provider"],
  ["model", "model"],
  ["thinking", "thinking"],
] as const;

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function toRoute(row: Row): Route {
  return {
    id: Number(row.id),
    chat: Number(row.chat),
    user: Number(row.user),
    thread: Number(row.thread),
    bot: text(row.bot),
    session: text(row.session),
    sessionFile: text(row.session_file),
    title: text(row.title),
    provider: text(row.provider),
    model: text(row.model),
    thinking: text(row.thinking),
    created: Number(row.created),
    updated: Number(row.updated),
  };
}

export async function conversation(
  ctx: StoreContext,
  chat: number,
  user: number,
  thread = 0,
): Promise<Route> {
  const { db, instance, clock } = ctx;
  const now = clock();
  await db.run(
    "INSERT OR IGNORE INTO routes(instance,chat,user,thread,created,updated) VALUES(?,?,?,?,?,?)",
    [instance, chat, user, thread, now, now],
  );
  await db.run(
    "UPDATE routes SET bot=(SELECT id FROM bots WHERE instance=? AND chief=1) " +
      "WHERE instance=? AND chat=? AND user=? AND thread=? AND bot IS NULL",
    [instance, instance, chat, user, thread],
  );
  const rows = await db.query(
    "SELECT * FROM routes WHERE instance=? AND chat=? AND user=? AND thread=?",
    [instance, chat, user, thread],
  );
  return toRoute(rows[0] as Row);
}

export async function getRoute(ctx: StoreContext, id: number): Promise<Route | null> {
  const rows = await ctx.db.query("SELECT * FROM routes WHERE instance=? AND id=?", [
    ctx.instance,
    id,
  ]);
  return rows[0] ? toRoute(rows[0]) : null;
}

/** The actor's most recently used routes, and the group routes (user 0) unless told otherwise. */
export async function listRoutes(
  ctx: StoreContext,
  actor: number,
  opts: { groups?: boolean } = {},
): Promise<Route[]> {
  const rows = await ctx.db.query(
    "SELECT * FROM routes WHERE instance=? AND (user=? OR (? AND user=0)) " +
      "ORDER BY updated DESC,id DESC LIMIT ?",
    [ctx.instance, actor, (opts.groups ?? true) ? 1 : 0, LIST_LIMIT],
  );
  return rows.map(toRoute);
}

async function current(ctx: StoreContext, route: Route): Promise<Route> {
  const fresh = await getRoute(ctx, route.id);
  if (!fresh) throw new Error(`No route ${route.id}`);
  return fresh;
}

/** Writes the session fields present in `state` and keeps the session's owner record current. */
export async function persistRoute(
  ctx: StoreContext,
  route: Route,
  state: Partial<Route>,
): Promise<Route> {
  const { db, instance, clock } = ctx;
  const now = clock();
  const assignments: string[] = ["updated=?"];
  const params: Param[] = [now];
  for (const [field, column] of SESSION_FIELDS) {
    if (state[field] === undefined) continue;
    assignments.push(`${column}=?`);
    params.push(state[field]);
  }
  await db.run(`UPDATE routes SET ${assignments.join(",")} WHERE instance=? AND id=?`, [
    ...params,
    instance,
    route.id,
  ]);
  const fresh = await current(ctx, route);
  if (fresh.session) {
    await db.run(
      "INSERT OR IGNORE INTO session_owners(instance,session,chat,user,thread,created,updated) " +
        "VALUES(?,?,?,?,?,?,?)",
      [instance, fresh.session, fresh.chat, fresh.user, fresh.thread, now, now],
    );
    if (await owns(ctx, fresh.chat, fresh.user, fresh.thread, fresh.session)) {
      await remember(ctx, fresh.chat, fresh.user, fresh.thread, {
        session: fresh.session,
        sessionFile: fresh.sessionFile,
        title: fresh.title,
        provider: fresh.provider,
        model: fresh.model,
        thinking: fresh.thinking,
      });
    }
  }
  return fresh;
}

/** Makes `route` continue exactly where `source` is: same bot and same session. */
export async function point(ctx: StoreContext, route: Route, source: Route): Promise<Route> {
  await ctx.db.run(
    "UPDATE routes SET session=?,session_file=?,title=?,provider=?,model=?,thinking=?," +
      "bot=?,updated=? WHERE instance=? AND id=?",
    [
      source.session,
      source.sessionFile,
      source.title,
      source.provider,
      source.model,
      source.thinking,
      source.bot,
      ctx.clock(),
      ctx.instance,
      route.id,
    ],
  );
  return current(ctx, route);
}

/** Parks the route's session under its current bot and resumes whatever the new bot had. */
export async function switchBot(ctx: StoreContext, route: Route, botId: string): Promise<Route> {
  const { db, instance, clock } = ctx;
  const known = await db.query("SELECT 1 FROM bots WHERE instance=? AND id=?", [instance, botId]);
  if (known.length === 0) throw new Error(`Unknown bot ${botId}`);
  const live = await current(ctx, route);
  if (live.bot) {
    await db.run(
      "INSERT OR REPLACE INTO route_bots(route,bot,session,session_file,title,provider," +
        "model,thinking) VALUES(?,?,?,?,?,?,?,?)",
      [
        live.id,
        live.bot,
        live.session,
        live.sessionFile,
        live.title,
        live.provider,
        live.model,
        live.thinking,
      ],
    );
  }
  const kept = (
    await db.query(
      "SELECT session,session_file,title,provider,model,thinking FROM route_bots " +
        "WHERE route=? AND bot=?",
      [live.id, botId],
    )
  )[0];
  await db.run(
    "UPDATE routes SET bot=?,session=?,session_file=?,title=?,provider=?,model=?,thinking=?," +
      "updated=? WHERE instance=? AND id=?",
    [
      botId,
      text(kept?.session),
      text(kept?.session_file),
      text(kept?.title),
      text(kept?.provider),
      text(kept?.model),
      text(kept?.thinking),
      clock(),
      instance,
      live.id,
    ],
  );
  return current(ctx, route);
}

export async function owns(
  ctx: StoreContext,
  chat: number,
  user: number,
  thread: number,
  session: string,
): Promise<boolean> {
  const rows = await ctx.db.query(
    "SELECT 1 FROM session_owners WHERE instance=? AND session=? AND chat=? AND user=? " +
      "AND thread=?",
    [ctx.instance, session, chat, user, thread],
  );
  return rows.length > 0;
}

/** Records a session's details for the person and thread that own it. */
export async function remember(
  ctx: StoreContext,
  chat: number,
  user: number,
  thread: number,
  details: SessionDetails,
): Promise<void> {
  const { db, instance, clock } = ctx;
  const now = clock();
  await db.run(
    "INSERT OR IGNORE INTO session_owners(instance,session,chat,user,thread,created,updated) " +
      "VALUES(?,?,?,?,?,?,?)",
    [instance, details.session, chat, user, thread, now, now],
  );
  if (!(await owns(ctx, chat, user, thread, details.session))) {
    throw new Error("Unknown session owner");
  }
  await db.run(
    "UPDATE session_owners SET title=?,provider=?,model=?,thinking=?,updated=? " +
      "WHERE instance=? AND session=? AND chat=? AND user=? AND thread=?",
    [
      details.title ?? null,
      details.provider ?? null,
      details.model ?? null,
      details.thinking ?? null,
      now,
      instance,
      details.session,
      chat,
      user,
      thread,
    ],
  );
  const previous = (
    await db.query("SELECT data FROM session_status WHERE instance=? AND session=?", [
      instance,
      details.session,
    ])
  )[0];
  const merged: Record<string, unknown> = { ...parseDetails(previous?.data) };
  merged.session_id = details.session;
  merged.title = details.title ?? null;
  merged.provider = details.provider ?? null;
  merged.model = details.model ?? null;
  merged.thinking = details.thinking ?? null;
  if (details.sessionFile) merged.sessionFile = details.sessionFile;
  await db.run(
    "INSERT INTO session_status(instance,session,data) VALUES(?,?,?) " +
      "ON CONFLICT(instance,session) DO UPDATE SET data=excluded.data",
    [instance, details.session, JSON.stringify(merged)],
  );
}

function parseDetails(raw: unknown): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(String(raw ?? "{}"));
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const SAVED =
  "SELECT o.session,o.chat,o.user,o.thread,o.title,o.provider,o.model,o.thinking,o.created," +
  "o.updated,r.id,r.bot,s.data," +
  "(SELECT x.session_file FROM routes x WHERE x.instance=o.instance AND x.session=o.session " +
  "AND x.session_file IS NOT NULL ORDER BY x.updated DESC,x.id DESC LIMIT 1) AS route_file " +
  "FROM session_owners o " +
  "LEFT JOIN routes r ON r.instance=o.instance AND r.chat=o.chat AND r.user=o.user " +
  "AND r.thread=o.thread " +
  "LEFT JOIN session_status s ON s.instance=o.instance AND s.session=o.session";

function savedRoute(row: Row): Route {
  const data = parseDetails(row.data);
  const file = data.sessionFile ?? data.session_file ?? row.route_file;
  return toRoute({ ...row, id: row.id ?? 0, session_file: typeof file === "string" ? file : null });
}

export async function saved(ctx: StoreContext, session: string): Promise<Route | null> {
  const rows = await ctx.db.query(`${SAVED} WHERE o.instance=? AND o.session=?`, [
    ctx.instance,
    session,
  ]);
  return rows[0] ? savedRoute(rows[0]) : null;
}

/** One page of a thread's saved sessions, newest first. The extra row says there is more. */
export async function sessions(
  ctx: StoreContext,
  chat: number,
  user: number,
  thread = 0,
  offset = 0,
): Promise<Route[]> {
  const rows = await ctx.db.query(
    `${SAVED} WHERE o.instance=? AND o.chat=? AND o.user=? AND o.thread=? ` +
      "ORDER BY o.updated DESC,o.session LIMIT ? OFFSET ?",
    [ctx.instance, chat, user, thread, PAGE, offset],
  );
  return rows.map(savedRoute);
}

export async function logMessage(
  ctx: StoreContext,
  route: Route,
  body: string,
  direction: "in" | "out",
): Promise<void> {
  await ctx.db.run(
    "INSERT INTO messages(instance,route,direction,text,created) VALUES(?,?,?,?,?)",
    [ctx.instance, route.id, direction === "in" ? "inbound" : "outbound", body, ctx.clock()],
  );
}

export async function history(
  ctx: StoreContext,
  chat: number,
  user: number,
  limit = 100,
): Promise<LoggedMessage[]> {
  const route = await conversation(ctx, chat, user, 0);
  const rows = await ctx.db.query(
    "SELECT direction,text,created FROM messages WHERE instance=? AND route=? " +
      "AND text IS NOT NULL ORDER BY id DESC LIMIT ?",
    [ctx.instance, route.id, limit],
  );
  return rows.reverse().map((row) => ({
    direction: row.direction === "inbound" ? "in" : "out",
    text: String(row.text),
    created: Number(row.created),
  }));
}
