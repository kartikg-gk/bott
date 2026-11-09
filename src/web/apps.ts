/**
 * Where connected apps plug into the web gateway. A seam does three things:
 * - `attach`: gives each account's gateway the apps its bots may use;
 * - `routes`: adds the routes that list, connect, disconnect and grant apps;
 * - `callback`: finishes a connection when the provider sends the browser back.
 *
 * `connectedApps` is the seam for signed-in accounts. `NO_APPS` adds nothing, which is what the
 * single-token mode on this machine uses. `accountAppStores` backs the stores the apps layer asks
 * for with the account tables: credentials sealed to account, kind and name; started connections
 * held as digests; and the shared limit on key checks.
 */

import { HttpError } from "../accounts/http.ts";
import type { Account, AccountStore } from "../accounts/store.ts";
import { BotApps } from "../apps/access.ts";
import type { ComposioAccounts } from "../apps/composio.ts";
import { type AppConnections, type Caller, ConnectionError } from "../apps/connections.ts";
import type { ApiRouter, Ctx } from "./context.ts";
import type { Gateway } from "./gateway.ts";
import { fresh, readJson } from "./router.ts";

export interface AppsSeam {
  /** Called with each gateway as it is built; `account` is null on this machine's own gateway. */
  attach(gateway: Gateway, account: Account | null): void | Promise<void>;
  /** Adds the app routes to the API. */
  routes(router: ApiRouter): void;
  /** Answers the provider's redirect to `/auth/apps/<name>/callback` for a signed-in person. */
  callback?(ctx: Ctx, name: string, url: URL): Promise<Response>;
}

/** The seam while the apps layer is not part of the build: it adds nothing. */
export const NO_APPS: AppsSeam = {
  attach() {},
  routes() {},
};

/** An account's secrets, sealed by the account store. `get` throws when one will not open. */
export interface SealedCredentials {
  get(account: string, kind: string, name: string): Promise<string | null>;
  put(account: string, kind: string, name: string, value: string): Promise<void>;
  delete(account: string, kind: string, name: string): Promise<void>;
}

/** Started app connections; each works once, for the browser session that began it. */
export interface AppFlows {
  start(
    account: string,
    app: string,
    session: string,
    state: string,
    verifier: string,
  ): Promise<void>;
  consume(account: string, app: string, session: string, state: string): Promise<string | null>;
  forget(account: string, app: string): Promise<void>;
  holdCode(account: string, app: string, code: string): Promise<void>;
  codeOwner(app: string, code: string): Promise<string | null>;
  codeWaiting(account: string, app: string): Promise<boolean>;
}

/** How often one account may ask the server to check a key or start a link. */
export interface Attempts {
  attempt(account: string): Promise<boolean>;
}

/** The apps layer's three stores, kept in the account tables. */
export function accountAppStores(store: AccountStore): {
  credentials: SealedCredentials;
  flows: AppFlows;
  attempts: Attempts;
} {
  return {
    credentials: {
      get: (account, kind, name) => store.credential(account, kind, name),
      put: (account, kind, name, value) => store.putCredential(account, kind, name, value),
      delete: (account, kind, name) => store.deleteCredential(account, kind, name),
    },
    flows: {
      start: (account, app, session, state, verifier) =>
        store.startAppFlow(account, app, session, state, verifier),
      consume: (account, app, session, state) => store.consumeAppFlow(account, app, session, state),
      forget: async (account, app) => {
        await store.db.run("DELETE FROM app_flows WHERE account=? AND app=?", [account, app]);
      },
      holdCode: (account, app, code) => store.holdAppCode(account, app, code),
      codeOwner: (app, code) => store.appCodeOwner(app, code),
      codeWaiting: (account, app) => store.appCodeWaiting(account, app),
    },
    attempts: { attempt: (account) => store.validationAttempt(account) },
  };
}

/** Who is asking, as the apps layer needs it; only signed-in accounts have apps. */
function caller(ctx: Ctx): Caller {
  if (!ctx.account) throw new HttpError(404, "Apps need a signed-in account");
  return { account: ctx.account.id, session: ctx.session ?? "", signedIn: () => ctx.alive() };
}

/** Runs one apps call, turning its refusals into HTTP errors the API already answers. */
async function answer<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConnectionError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

/** The seam for signed-in accounts, backed by their app connections. */
export function connectedApps(connections: AppConnections, composio?: ComposioAccounts): AppsSeam {
  return {
    attach(gateway, account) {
      if (!account) return;
      const extra = composio?.configured ? composio.forAccount(account.id) : undefined;
      gateway.sessions.apps = new BotApps(gateway.store, connections.runner(account.id), extra);
    },
    routes(router) {
      const call = <T>(ctx: Ctx, work: (who: Caller) => Promise<T>) =>
        answer(async () => fresh(await work(caller(ctx))));
      if (composio) composioRoutes(router, composio, call);
      router
        .add("GET", "/api/apps", (ctx) => call(ctx, (who) => connections.list(who)))
        .add("GET", "/api/apps/bland/calls/:call", (ctx, request, params) =>
          call(ctx, (who) =>
            connections.blandCall(
              who,
              params.call as string,
              new URL(request.url).searchParams.get("offset"),
            ),
          ),
        )
        .add("POST", "/api/apps/telegram/confirm", (ctx) =>
          call(ctx, (who) => connections.confirmTelegram(who)),
        )
        .add("POST", "/api/apps/:app/connect", (ctx, _r, params) =>
          call(ctx, (who) => connections.connect(who, params.app as string)),
        )
        .add("PUT", "/api/apps/:app/key", async (ctx, request, params) => {
          const body = await readJson(request);
          return call(ctx, (who) => connections.saveKey(who, params.app as string, body));
        })
        .add("DELETE", "/api/apps/:app", (ctx, _r, params) =>
          call(ctx, (who) => connections.disconnect(who, params.app as string)),
        )
        .add("PUT", "/api/apps/:app/bots/:bot", async (ctx, request, params) => {
          const body = await readJson(request);
          return call(ctx, (who) =>
            connections.grant(who, params.app as string, params.bot as string, body),
          );
        });
    },
    async callback(ctx, name, url) {
      const target = await answer(() =>
        connections.callback(caller(ctx), name, {
          state: url.searchParams.get("state"),
          code: url.searchParams.get("code"),
        }),
      );
      return new Response(null, { status: 303, headers: { Location: target } });
    },
  };
}

/**
 * Composio toolkits, kept apart from the built-in apps:
 * - GET    /api/apps/composio                          every toolkit and its bots
 * - POST   /api/apps/composio/:toolkit/connect         starts hosted sign-in
 * - GET    /api/apps/composio/:toolkit/status          asks Composio how it stands
 * - DELETE /api/apps/composio/:toolkit                 forgets it
 * - PUT    /api/apps/composio/:toolkit/bots/:bot       {enabled} grants or stops one bot
 */
function composioRoutes(
  router: ApiRouter,
  composio: ComposioAccounts,
  call: <T>(ctx: Ctx, work: (who: Caller) => Promise<T>) => Promise<Response>,
): void {
  router
    .add("GET", "/api/apps/composio", (ctx) => call(ctx, (who) => composio.list(who)))
    .add("POST", "/api/apps/composio/:toolkit/connect", (ctx, _r, params) =>
      call(ctx, (who) => composio.connect(who, params.toolkit as string)),
    )
    .add("GET", "/api/apps/composio/:toolkit/status", (ctx, _r, params) =>
      call(ctx, (who) => composio.status(who, params.toolkit as string)),
    )
    .add("DELETE", "/api/apps/composio/:toolkit", (ctx, _r, params) =>
      call(ctx, (who) => composio.disconnect(who, params.toolkit as string)),
    )
    .add("PUT", "/api/apps/composio/:toolkit/bots/:bot", async (ctx, request, params) => {
      const body = await readJson(request);
      return call(ctx, (who) =>
        composio.grant(who, params.toolkit as string, params.bot as string, body),
      );
    });
}
