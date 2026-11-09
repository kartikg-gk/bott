import { HttpError } from "../../accounts/http.ts";
import type { Bot } from "../../bots/bots.ts";
import { approvalView } from "../channel.ts";
import type { ApiRouter, Ctx } from "../context.ts";
import type { RunView } from "../journal.ts";
import { fresh, readObject } from "../router.ts";
import { eventStream } from "../sse.ts";
import { isPrompt, messageText } from "./chat.ts";

/** How long a follower waits for news before saying it is still there, in milliseconds. */
const WAIT_MS = 2000;
const RUN_FIELDS = new Set(["text", "bot", "conversation"]);

async function lookup(ctx: Ctx, run: string): Promise<RunView> {
  const found = await ctx.gateway.journal.get(run, ctx.actor);
  if (!found) throw new HttpError(404, "No such run");
  return found;
}

/** A bot the person may start a run on: any kept bot, never a temporary one. */
async function keptBot(ctx: Ctx, id: unknown): Promise<Bot> {
  if (typeof id !== "string") throw new HttpError(400, "Name the bot by its id");
  const bot = await ctx.gateway.store.bot(id);
  if (!bot || bot.temporary) throw new HttpError(404, "No such bot");
  return bot;
}

/**
 * Sends the run's events after `after` as they are written, then ends once the run has
 * finished. A cursor that fell out of the kept window gets a `replay_gap` notice first.
 */
export function follow(ctx: Ctx, run: string, after: number): Response {
  const { journal } = ctx.gateway;
  return eventStream(
    async (out) => {
      let news = true;
      let wake: (() => void) | undefined;
      const stop = journal.subscribe(run, () => {
        news = true;
        wake?.();
      });
      const quit = () => wake?.();
      out.signal.addEventListener("abort", quit);
      let cursor = after;
      try {
        while (!journal.closed && !out.signal.aborted) {
          if (!(await ctx.alive())) break;
          news = false;
          const view = await journal.get(run, ctx.actor);
          const events = await journal.events(run, cursor);
          const first = events[0];
          if (first && first.seq > cursor + 1) {
            const gap = { type: "replay_gap", run, next: first.seq };
            await out.send(`event: replay_gap\ndata: ${JSON.stringify(gap)}\n\n`);
          }
          for (const event of events) {
            const payload = { type: event.kind, run, ...event.data };
            await out.send(
              `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(payload)}\n\n`,
            );
            cursor = event.seq;
          }
          if (view === null || view.finished !== null) break;
          if (news) continue;
          const woke = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), WAIT_MS);
            wake = () => {
              clearTimeout(timer);
              resolve(true);
            };
          });
          wake = undefined;
          if (!woke) await out.send(": still here\n\n");
        }
      } finally {
        stop();
        out.signal.removeEventListener("abort", quit);
      }
    },
    { "X-Accel-Buffering": "no", "X-Run-ID": run },
  );
}

async function create(ctx: Ctx, request: Request): Promise<Response> {
  const body = await readObject(request, "Send the run request as JSON");
  if (Object.keys(body).some((key) => !RUN_FIELDS.has(key))) {
    throw new HttpError(400, "A run takes text, and optionally a bot id and earlier messages");
  }
  const text = messageText(body);
  if (!isPrompt(text)) throw new HttpError(400, "Send control names to /api/messages instead");
  const bot = "bot" in body ? await keptBot(ctx, body.bot) : null;
  const { gateway } = ctx;
  await gateway.requireModel(ctx.account);
  const route = await gateway.journal.route(ctx.actor, bot);
  const { run } = await gateway.queueRun(route, text, body.conversation);
  await gateway.dispatch();
  if ((request.headers.get("accept") ?? "").includes("text/event-stream")) {
    return follow(ctx, run, 0);
  }
  return fresh(await lookup(ctx, run), 202, { Location: `/api/runs/${run}` });
}

async function list(ctx: Ctx, request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const bot = query.get("bot");
  if (query.get("recent") === "1") {
    return fresh(await ctx.gateway.journal.recent(ctx.actor, bot));
  }
  const runs = await ctx.gateway.journal.active(ctx.actor);
  return fresh(runs.filter((run) => !bot || run.bot === bot));
}

async function events(ctx: Ctx, request: Request, params: Record<string, string>) {
  const run = params.run as string;
  await lookup(ctx, run);
  const raw =
    request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^[0-9]{1,16}$/.test(raw)) throw new HttpError(400, "The event cursor must be a number");
  return follow(ctx, run, Number(raw));
}

async function stop(ctx: Ctx, _request: Request, params: Record<string, string>) {
  const run = params.run as string;
  const current = await lookup(ctx, run);
  if (params.bot !== undefined && current.bot !== params.bot) {
    throw new HttpError(404, "That bot has no such run");
  }
  if (!(await ctx.gateway.stopRun(run, ctx.actor))) {
    throw new HttpError(409, "This run has already ended or is being stopped");
  }
  return fresh(await lookup(ctx, run));
}

async function approvals(ctx: Ctx, request: Request): Promise<Response> {
  const run = new URL(request.url).searchParams.get("run") || undefined;
  if (run) await lookup(ctx, run);
  return fresh(ctx.gateway.dispatcher.approvals(ctx.actor, run).map(approvalView));
}

export function runRoutes(router: ApiRouter): void {
  router
    .add("GET", "/api/runs", list)
    .add("POST", "/api/runs", create)
    .add("GET", "/api/runs/:run", async (ctx, _r, params) =>
      fresh(await lookup(ctx, params.run as string)),
    )
    .add("GET", "/api/runs/:run/events", events)
    .add("GET", "/api/runs/:run/activity", async (ctx, _r, params) => {
      const run = params.run as string;
      await lookup(ctx, run);
      return fresh(await ctx.gateway.journal.activity(run));
    })
    .add("POST", "/api/runs/:run/stop", stop)
    .add("POST", "/api/bots/:bot/runs/:run/stop", stop)
    .add("GET", "/api/approvals", approvals);
}
