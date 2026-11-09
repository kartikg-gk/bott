/**
 * Long-term memory for the person, per bot project.
 *
 * Every route takes an optional `?bot=<id>` naming a kept bot; without it the main
 * conversation's bot is meant. Refusals: 409 while memory is off, 400 for other refusals.
 *
 * - GET  /api/memory                              -> MemorySummary { bot, facts: Fact[], episodes, conflicts, failed }
 * - GET  /api/memory/(facts|episodes|conflicts|forgotten) -> Fact[]
 * - POST /api/memory/search  { text }             -> Fact[]
 * - POST /api/memory         { text }             -> 201 { id }
 * - POST /api/memory/retry                        -> { retried, failed }
 * - POST /api/memory/:id/(forget|restore|keep)    -> { [action]: id }
 *
 * Fact: { id, kind, text, tags, confidence, source, status, created, conflict }.
 */

import { HttpError } from "../../accounts/http.ts";
import type { MemoryView } from "../../memory/controls.ts";
import { MemoryError } from "../../memory/facts.ts";
import type { Route } from "../../store/routes.ts";
import type { ApiRouter, Ctx } from "../context.ts";
import { fresh, readObject } from "../router.ts";

const VIEWS = "facts|episodes|conflicts|forgotten";
const TEXT_LIMIT = 4000;

/** The conversation whose bot's memory is meant: the main one, or a kept bot's own thread. */
async function routeFor(ctx: Ctx, request: Request): Promise<Route> {
  const id = new URL(request.url).searchParams.get("bot");
  if (!id) return ctx.gateway.journal.route(ctx.actor, null);
  const bot = await ctx.gateway.store.bot(id);
  if (!bot || bot.temporary) throw new HttpError(404, "No such bot");
  return ctx.gateway.journal.route(ctx.actor, bot);
}

/** Runs a memory call, turning its refusals into answers the page can show. */
async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MemoryError) {
      throw new HttpError(/not enabled/.test(error.message) ? 409 : 400, error.message);
    }
    throw error;
  }
}

async function bodyText(request: Request): Promise<string> {
  const body = await readObject(request, "Send the text as a JSON object");
  if (typeof body.text !== "string" || body.text.length > TEXT_LIMIT) {
    throw new HttpError(400, `Send up to ${TEXT_LIMIT} characters of text`);
  }
  return body.text;
}

export function memoryRoutes(router: ApiRouter): void {
  router
    .add("GET", "/api/memory", async (ctx, request) => {
      const route = await routeFor(ctx, request);
      return fresh(await attempt(() => ctx.gateway.memory.summary(route, ctx.actor)));
    })
    .add("GET", `/api/memory/:view(${VIEWS})`, async (ctx, request, params) => {
      const route = await routeFor(ctx, request);
      const view = params.view as MemoryView;
      return fresh(await attempt(() => ctx.gateway.memory.list(route, ctx.actor, view)));
    })
    .add("POST", "/api/memory/search", async (ctx, request) => {
      const route = await routeFor(ctx, request);
      const wanted = await bodyText(request);
      return fresh(await attempt(() => ctx.gateway.memory.search(route, ctx.actor, wanted)));
    })
    .add("POST", "/api/memory", async (ctx, request) => {
      const route = await routeFor(ctx, request);
      const fact = await bodyText(request);
      const id = await attempt(() => ctx.gateway.memory.remember(route, ctx.actor, fact));
      return fresh({ id }, 201);
    })
    .add("POST", "/api/memory/retry", async (ctx, request) => {
      const route = await routeFor(ctx, request);
      return fresh(await attempt(() => ctx.gateway.memory.retry(route, ctx.actor)));
    })
    .add(
      "POST",
      "/api/memory/:id(\\d{1,15})/:action(forget|restore|keep)",
      async (ctx, request, params) => {
        const route = await routeFor(ctx, request);
        const id = Number(params.id);
        const { memory } = ctx.gateway;
        await attempt(() => {
          if (params.action === "forget") return memory.forget(route, ctx.actor, id);
          if (params.action === "restore") return memory.restore(route, ctx.actor, id);
          return memory.keep(route, ctx.actor, id);
        });
        return fresh({ [params.action as string]: id });
      },
    );
}
