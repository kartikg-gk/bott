import { z } from "zod";
import { HttpError } from "../../accounts/http.ts";
import type { Bot } from "../../bots/bots.ts";
import { profile, recordChat, saveProfile, validateProfile } from "../../bots/profiles.ts";
import { ConstraintError } from "../../db/database.ts";
import { WEB_CHAT } from "../../store/store.ts";
import type { ApiRouter, Ctx } from "../context.ts";
import { ACTIVE } from "../journal.ts";
import { fresh, readJson } from "../router.ts";

const changes = z
  .object({
    name: z.string().min(1).max(100),
    role: z.string().min(1).max(10_000),
    instructions: z.string().max(10_000),
    style: z.enum(["direct", "thoughtful", "upbeat", "custom"]),
    voice: z.string().max(2000),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    shape: z.enum(["orb", "diamond", "square"]),
  })
  .partial()
  .strict();

type Changes = z.infer<typeof changes>;
const LOOKS = ["style", "voice", "color", "shape"] as const;
const GREETING_PROMPT =
  "In one short sentence, say hello to the person and tell them what you can help with. " +
  "Use no tools.";
const GREETING_SECONDS = 30;
/** Rows a deleted bot leaves behind that only it used. */
const BOT_ROWS = ["bot_profiles", "bot_sessions", "bot_chat", "bot_plugins"];

async function readChanges(request: Request): Promise<Changes> {
  const parsed = changes.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, "Those bot settings are not valid");
  const values = parsed.data;
  if ([values.name, values.role].some((value) => value !== undefined && !value.trim())) {
    throw new HttpError(400, "A bot's name and purpose need some text");
  }
  return values;
}

/** A bot the person can see; temporary bots, the memory extractor among them, stay hidden. */
async function visible(ctx: Ctx, id: string): Promise<Bot> {
  const bot = await ctx.gateway.store.bot(id);
  if (!bot || bot.temporary) throw new HttpError(404, "No such bot");
  return bot;
}

function requireIdle(ctx: Ctx, bot: Bot): void {
  if (ctx.gateway.sessions.isBusy(bot.id)) {
    throw new HttpError(409, `${bot.name} is working; try again when it has finished`);
  }
}

async function view(ctx: Ctx, bot: Bot): Promise<Record<string, unknown>> {
  const { nameKey: _key, ...fields } = bot;
  return {
    ...fields,
    ...(await profile(ctx.gateway.store, bot.id)),
    busy: ctx.gateway.sessions.isBusy(bot.id),
  };
}

function looks(values: Changes): Partial<Record<(typeof LOOKS)[number], string>> {
  const picked: Partial<Record<(typeof LOOKS)[number], string>> = {};
  for (const key of LOOKS) if (values[key] !== undefined) picked[key] = values[key];
  return picked;
}

async function list(ctx: Ctx): Promise<Response> {
  const { store } = ctx.gateway;
  const selected = (await store.conversation(WEB_CHAT, ctx.actor)).bot;
  const rows = [];
  for (const bot of await store.bots()) {
    rows.push({ ...(await view(ctx, bot)), selected: bot.id === selected });
  }
  return fresh(rows);
}

async function replyCounts(ctx: Ctx): Promise<Response> {
  const { db, instance } = ctx.gateway.store.ctx;
  const rows = await db.query(
    "SELECT c.bot AS bot,count(*) AS n FROM bot_chat c JOIN bots b ON b.instance=c.instance " +
      "AND b.id=c.bot WHERE c.instance=? AND c.role='assistant' AND b.temporary=0 GROUP BY c.bot",
    [instance],
  );
  return fresh(Object.fromEntries(rows.map((row) => [String(row.bot), Number(row.n)])));
}

async function create(ctx: Ctx, request: Request): Promise<Response> {
  const values = await readChanges(request);
  if (!values.name || !values.role) throw new HttpError(400, "Give the bot a name and a purpose");
  const { store } = ctx.gateway;
  const chosen = looks(values);
  try {
    // The look is checked before anything is saved, so a refused one leaves no bot behind.
    validateProfile({ ...(await profile(store, "000000")), ...chosen });
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  let bot: Bot;
  try {
    bot = await store.createBot({
      name: values.name,
      role: values.role,
      instructions: values.instructions ?? "",
    });
  } catch {
    throw new HttpError(409, "Another bot already has that name");
  }
  if (Object.keys(chosen).length > 0) await saveProfile(store, bot.id, chosen);
  return fresh(await view(ctx, bot), 201);
}

async function update(ctx: Ctx, request: Request, params: Record<string, string>) {
  const bot = await visible(ctx, params.bot as string);
  const values = await readChanges(request);
  requireIdle(ctx, bot);
  const { store, sessions } = ctx.gateway;
  const chosen = looks(values);
  try {
    validateProfile({ ...(await profile(store, bot.id)), ...chosen });
  } catch (error) {
    throw new HttpError(409, (error as Error).message);
  }
  if (values.name !== undefined) {
    const name = values.name.trim();
    const { db, instance } = store.ctx;
    try {
      await db.run("UPDATE bots SET name=?,name_key=? WHERE instance=? AND id=?", [
        name,
        name.toLowerCase(),
        instance,
        bot.id,
      ]);
    } catch (error) {
      if (error instanceof ConstraintError) {
        throw new HttpError(409, "Another bot already has that name");
      }
      throw error;
    }
  }
  if (values.role !== undefined || values.instructions !== undefined) {
    await store.updateBot(bot.id, {
      ...(values.role === undefined ? {} : { role: values.role }),
      ...(values.instructions === undefined ? {} : { instructions: values.instructions }),
    });
  }
  if (Object.keys(chosen).length > 0) await saveProfile(store, bot.id, chosen);
  sessions.restartIdle(bot.id);
  return fresh(await view(ctx, (await store.bot(bot.id)) as Bot));
}

async function remove(ctx: Ctx, _request: Request, params: Record<string, string>) {
  const bot = await visible(ctx, params.bot as string);
  if (bot.chief) throw new HttpError(409, "The chief can be changed but not deleted");
  requireIdle(ctx, bot);
  const { store, sessions } = ctx.gateway;
  const { db, instance } = store.ctx;
  const waiting = await db.query(
    "SELECT 1 FROM inbox i JOIN routes r ON r.instance=i.instance AND r.chat=i.chat " +
      "AND r.user=coalesce(i.route_user,i.user) AND r.thread=i.thread WHERE r.instance=? " +
      `AND r.bot=? AND i.status IN (${ACTIVE.map(() => "?").join(",")}) LIMIT 1`,
    [instance, bot.id, ...ACTIVE],
  );
  if (waiting.length > 0) {
    throw new HttpError(409, "This bot still has messages waiting or running; let them end first");
  }
  try {
    await sessions.removeComputer(bot);
  } catch (error) {
    throw new HttpError(409, (error as Error).message);
  }
  const chief = await store.chief();
  // Every step can be repeated, and the bot row goes last, so a cut-off delete can be retried.
  for (const table of BOT_ROWS) {
    await db.run(`DELETE FROM ${table} WHERE instance=? AND bot=?`, [instance, bot.id]);
  }
  await db.run(
    "DELETE FROM route_bots WHERE route IN (SELECT id FROM routes WHERE instance=?) AND bot=?",
    [instance, bot.id],
  );
  await db.run(
    "UPDATE jobs SET status='cancelled',next_run=NULL,version=version+1 WHERE instance=? " +
      "AND bot=? AND status IN ('active','paused')",
    [instance, bot.id],
  );
  await db.run(
    "UPDATE routes SET bot=?,session=NULL,session_file=NULL WHERE instance=? AND bot=?",
    [chief.id, instance, bot.id],
  );
  await db.run("DELETE FROM bots WHERE instance=? AND id=?", [instance, bot.id]);
  return fresh({ deleted: bot.id });
}

async function select(ctx: Ctx, _request: Request, params: Record<string, string>) {
  const bot = await visible(ctx, params.bot as string);
  const { store, sessions } = ctx.gateway;
  const route = await store.conversation(WEB_CHAT, ctx.actor);
  const { db, instance } = store.ctx;
  const going = await db.query(
    "SELECT 1 FROM inbox WHERE instance=? AND chat=? AND coalesce(route_user,user)=CAST(? AS INTEGER) " +
      `AND thread=? AND status IN (${ACTIVE.map(() => "?").join(",")}) LIMIT 1`,
    [instance, route.chat, route.user, route.thread, ...ACTIVE],
  );
  if (going.length > 0) {
    throw new HttpError(409, "Let the current conversation finish before switching bots");
  }
  await sessions.switchBot(route, bot);
  return fresh(await view(ctx, bot));
}

async function chat(ctx: Ctx, botId: string, limit: number | null): Promise<unknown[]> {
  const { db, instance } = ctx.gateway.store.ctx;
  const rows = await db.query(
    "SELECT role,text FROM bot_chat WHERE instance=? AND bot=? ORDER BY id DESC" +
      (limit === null ? "" : ` LIMIT ${limit}`),
    [instance, botId],
  );
  return rows.reverse().map((row) => ({ role: String(row.role), text: String(row.text) }));
}

async function greeting(ctx: Ctx, _request: Request, params: Record<string, string>) {
  const bot = await visible(ctx, params.bot as string);
  const { store, sessions } = ctx.gateway;
  const saved = (await profile(store, bot.id)).greeting;
  if (saved) return fresh({ text: saved });
  requireIdle(ctx, bot);
  let answer: { text: string; outcome: string };
  try {
    // A greeting runs read-only, with every tool call refused, and leaves no history behind.
    answer = await sessions.background(
      await store.conversation(WEB_CHAT, ctx.actor),
      bot,
      GREETING_PROMPT,
      {
        policy: "deny",
        readOnly: true,
        detached: true,
        signal: AbortSignal.timeout(GREETING_SECONDS * 1000),
      },
    );
  } catch {
    throw new HttpError(409, "This bot is busy or cannot be reached right now");
  }
  if (answer.outcome !== "completed" || !answer.text.trim()) {
    throw new HttpError(503, "The greeting could not be written");
  }
  const text = answer.text.trim();
  await saveProfile(store, bot.id, {});
  const { db, instance } = store.ctx;
  await db.run("UPDATE bot_profiles SET greeting=? WHERE instance=? AND bot=?", [
    text,
    instance,
    bot.id,
  ]);
  await recordChat(store, bot.id, "assistant", text);
  return fresh({ text });
}

export function botRoutes(router: ApiRouter): void {
  router
    .add("GET", "/api/bots", list)
    .add("GET", "/api/bots/unread-counts", replyCounts)
    .add("POST", "/api/bots", create)
    .add("PATCH", "/api/bots/:bot", update)
    .add("DELETE", "/api/bots/:bot", remove)
    .add("POST", "/api/bots/:bot/select", select)
    .add("POST", "/api/bots/:bot/greeting", greeting)
    .add("GET", "/api/bots/:bot/messages", async (ctx, _r, params) => {
      const bot = await visible(ctx, params.bot as string);
      return fresh(await chat(ctx, bot.id, 200));
    })
    .add("GET", "/api/bots/:bot/export", async (ctx, _r, params) => {
      const bot = await visible(ctx, params.bot as string);
      return fresh(await chat(ctx, bot.id, null));
    });
}
