/**
 * Each bot's web browser, as the page sees it.
 *
 * Google mode, the account's Cloudflare Browser Run key:
 * - GET    /api/account/browser  -> { saved: boolean, accountId: string | null }
 * - PUT    /api/account/browser  { accountId, token } -> same shape; the token is checked with
 *     Cloudflare first. 400 malformed or turned down, 401 signed out meanwhile, 429 too many
 *     checks, 502 Cloudflare unreachable or failing.
 * - DELETE /api/account/browser  -> { saved: false, accountId: null }
 * Without a key, bots are not offered the browser tools.
 *
 * Either mode, a running run's browser:
 * - GET /api/runs/:run/browser?mode=tab|devtools|full
 *     -> { engine: "kitesurf", image: { type: "image/jpeg", data: <base64> } }
 *      | { engine: "chromium", mode, url, expiresInMs }
 *     Kitesurf gives a fresh screenshot on every call; Chromium gives a Cloudflare Live View
 *     link to watch, take over (mode "tab" or "full") or open DevTools (mode "devtools").
 *     `mode` defaults to "tab" and only matters for Chromium. 404 when the run is not the
 *     person's, or has no browser open in the process that answers.
 */

import { HttpError } from "../../accounts/http.ts";
import type { Account } from "../../accounts/store.ts";
import type { BrowserKeys } from "../../browser/keys.ts";
import { LIVE_MODES, type LiveMode } from "../../browser/tools.ts";
import type { ApiRouter, Ctx } from "../context.ts";
import { fresh, readJson } from "../router.ts";

/** The routes that save, check and remove the signed-in account's Browser Run key. */
export function browserKeyRoutes(router: ApiRouter, keys: BrowserKeys): void {
  const who = (ctx: Ctx) => (ctx.account as Account).id;
  router
    .add("GET", "/api/account/browser", async (ctx) => fresh(await keys.settings(who(ctx))))
    .add("PUT", "/api/account/browser", async (ctx, request) =>
      fresh(await keys.save(who(ctx), await readJson(request), () => ctx.alive())),
    )
    .add("DELETE", "/api/account/browser", async (ctx) => fresh(await keys.remove(who(ctx))));
}

/** The live view of a run's browser. */
export function browserViewRoutes(router: ApiRouter): void {
  router.add("GET", "/api/runs/:run/browser", async (ctx, request, params) => {
    const run = params.run as string;
    if (!(await ctx.gateway.journal.get(run, ctx.actor))) throw new HttpError(404, "No such run");
    const asked = new URL(request.url).searchParams.get("mode") ?? "tab";
    if (!(LIVE_MODES as readonly string[]).includes(asked)) {
      throw new HttpError(400, "The mode is tab, devtools or full");
    }
    const browser = ctx.gateway.sessions.browser;
    const view = browser ? await browser.view(run, asked as LiveMode).catch(() => null) : null;
    if (!view) throw new HttpError(404, "This run has no browser open here");
    return fresh(view);
  });
}
