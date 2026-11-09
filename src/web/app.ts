import { timingSafeEqual } from "node:crypto";
import { cookie, type GoogleLogin, SESSION_COOKIE } from "../accounts/google.ts";
import { HttpError } from "../accounts/http.ts";
import { bearerAllowed } from "../accounts/localToken.ts";
import type { AccountModels } from "../accounts/models.ts";
import type { Account } from "../accounts/store.ts";
import { botRoutes } from "./api/bots.ts";
import { chatRoutes } from "./api/chat.ts";
import { jobRoutes } from "./api/jobs.ts";
import { resourceRoutes } from "./api/resources.ts";
import { runRoutes } from "./api/runs.ts";
import type { ApiRouter, Ctx } from "./context.ts";
import type { Gateway } from "./gateway.ts";
import { fresh, Router, readJson } from "./router.ts";

/** The environment variable holding the secret a trusted proxy sends with every request. */
export const PROXY_SECRET_VARIABLE = "BOTT_PROXY_SECRET";
/** The header that secret arrives in. */
export const PROXY_HEADER = "x-bott-proxy";
const PROXY_SECRET = /^[A-Za-z0-9_-]{43,128}$/;

/** One person on this machine, unlocked with a bearer token. */
export interface TokenAuth {
  mode: "token";
  token: string;
  gateway: Gateway;
}

/** Google sign-in, with a gateway of its own for each account. */
export interface GoogleAuth {
  mode: "google";
  login: GoogleLogin;
  models: AccountModels;
  gateway: (account: Account) => Promise<Gateway>;
}

export interface AppOptions {
  auth: TokenAuth | GoogleAuth;
  /** When set, every request must carry it in the proxy header; nothing reaches us directly. */
  proxySecret?: string | undefined;
  /** The page served at "/". */
  page?: string;
}

/** Every API route, for whichever gateway a request is resolved to. */
export function apiRouter(): ApiRouter {
  const router: ApiRouter = new Router<Ctx>();
  chatRoutes(router);
  runRoutes(router);
  botRoutes(router);
  jobRoutes(router);
  resourceRoutes(router);
  return router;
}

/** Turns anything a handler throws into a JSON error; unexpected ones say nothing inside. */
export function failure(error: unknown): Response {
  if (error instanceof HttpError) return fresh({ error: error.message }, error.status);
  return fresh({ error: "Something went wrong on the server" }, 500);
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The routes Google mode adds: the person's model choice and saved keys. */
function accountRoutes(router: ApiRouter, models: AccountModels): void {
  const who = (ctx: Ctx) => (ctx.account as Account).id;
  router
    .add("GET", "/api/account/model", async (ctx) => fresh(await models.settings(who(ctx))))
    .add("PUT", "/api/account/model", async (ctx, request) =>
      fresh(await models.save(who(ctx), await readJson(request), () => ctx.alive())),
    )
    .add("DELETE", "/api/account/keys/:provider", async (ctx, _r, params) =>
      fresh(await models.remove(who(ctx), params.provider as string)),
    );
}

/** The request handler for the page and the API, in either sign-in mode. */
export function createApp(opts: AppOptions): (request: Request) => Promise<Response> {
  const { auth } = opts;
  if (opts.proxySecret !== undefined && !PROXY_SECRET.test(opts.proxySecret)) {
    throw new Error(`${PROXY_SECRET_VARIABLE} must be 43 to 128 URL-safe base64 characters`);
  }
  const router = apiRouter();
  if (auth.mode === "google") accountRoutes(router, auth.models);

  const page = () =>
    new Response(opts.page ?? "", {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });

  async function api(request: Request, path: string, ctx: Ctx): Promise<Response> {
    const found = router.match(request.method, path);
    if (found === null) return fresh({ error: "Not found" }, 404);
    if (found === "method") return fresh({ error: "That method is not allowed here" }, 405);
    const response = await found.handler(ctx, request, found.params);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  async function google(request: Request, path: string, setup: GoogleAuth): Promise<Response> {
    const { login } = setup;
    if (!login.requestAllowed(request, { trustedProxy: opts.proxySecret !== undefined })) {
      return fresh({ error: "This host or origin is not trusted" }, 403);
    }
    const get = request.method === "GET" || request.method === "HEAD";
    if (path === "/auth/login" && get) return login.start(request);
    if (path === "/auth/callback" && get) return login.callback(request);
    if (path === "/auth/logout" && request.method === "POST") return login.logout(request);
    const token = cookie(request, SESSION_COOKIE);
    const account = await login.identity(token);
    if (path === "/auth/session" && get) {
      return fresh({ mode: "google", email: account?.email ?? null });
    }
    if (path === "/" && get) return page();
    if (!path.startsWith("/api/")) return fresh({ error: "Not found" }, 404);
    if (!account) return fresh({ error: "Sign in with Google first" }, 401);
    const gateway = await setup.gateway(account);
    return api(request, path, {
      gateway,
      actor: gateway.actor,
      account,
      alive: async () => (await login.identity(token)) !== null,
    });
  }

  async function local(request: Request, path: string, setup: TokenAuth): Promise<Response> {
    const get = request.method === "GET" || request.method === "HEAD";
    if (path === "/" && get) return page();
    if (path === "/auth/session" && get) return fresh({ mode: "bearer", email: null });
    if (!path.startsWith("/api/")) return fresh({ error: "Not found" }, 404);
    if (!bearerAllowed(request.headers.get("authorization"), setup.token)) {
      return fresh({ error: "The token is missing or wrong" }, 401);
    }
    const { gateway } = setup;
    return api(request, path, {
      gateway,
      actor: gateway.actor,
      account: null,
      alive: async () => true,
    });
  }

  return async (request) => {
    try {
      if (opts.proxySecret !== undefined) {
        // Several copies of the header arrive joined by commas, which never match the secret.
        const sent = request.headers.get(PROXY_HEADER);
        if (sent === null || !sameText(sent, opts.proxySecret)) {
          return fresh({ error: "Requests must come through the trusted proxy" }, 403);
        }
      }
      const path = new URL(request.url).pathname;
      return auth.mode === "google"
        ? await google(request, path, auth)
        : await local(request, path, auth);
    } catch (error) {
      return failure(error);
    }
  };
}
