import { HttpError } from "../accounts/http.ts";
import { bearerAllowed } from "../accounts/localToken.ts";
import { chatRoutes } from "./api/chat.ts";
import type { ApiRouter, Ctx } from "./context.ts";
import type { Gateway } from "./gateway.ts";
import { fresh, Router } from "./router.ts";

export interface AppOptions {
  /** The single-person token for use on this machine. */
  token: string;
  gateway: Gateway;
  /** The page served at "/". */
  page?: string;
}

/** Every API route, for whichever gateway a request is resolved to. */
export function apiRouter(): ApiRouter {
  const router: ApiRouter = new Router<Ctx>();
  chatRoutes(router);
  return router;
}

/** Turns anything a handler throws into a JSON error; unexpected ones say nothing inside. */
export function failure(error: unknown): Response {
  if (error instanceof HttpError) return fresh({ error: error.message }, error.status);
  return fresh({ error: "Something went wrong on the server" }, 500);
}

/** The request handler for one person on this machine, unlocked with a bearer token. */
export function createApp(opts: AppOptions): (request: Request) => Promise<Response> {
  const router = apiRouter();
  return async (request) => {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/" && (request.method === "GET" || request.method === "HEAD")) {
        return new Response(opts.page ?? "", {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (path === "/auth/session" && request.method === "GET") {
        return fresh({ mode: "bearer", email: null });
      }
      if (!path.startsWith("/api/")) return fresh({ error: "Not found" }, 404);
      if (!bearerAllowed(request.headers.get("authorization"), opts.token)) {
        return fresh({ error: "The token is missing or wrong" }, 401);
      }
      const found = router.match(request.method, path);
      if (found === null) return fresh({ error: "Not found" }, 404);
      if (found === "method") return fresh({ error: "That method is not allowed here" }, 405);
      const ctx: Ctx = {
        gateway: opts.gateway,
        actor: opts.gateway.actor,
        account: null,
        alive: async () => true,
      };
      return await found.handler(ctx, request, found.params);
    } catch (error) {
      return failure(error);
    }
  };
}
