import type { Fetch } from "../../src/apps/http.ts";

export interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  /** The body read as JSON, or undefined when it is not JSON. */
  // biome-ignore lint/suspicious/noExplicitAny: tests read request bodies loosely
  json: any;
  /** The body read as a form, when it is one. */
  form: URLSearchParams;
}

export type Handler = (req: Seen) => Response | Promise<Response>;

export interface FakeFetch extends Fetch {
  seen: Seen[];
}

/**
 * A fake service: routes are "METHOD https://host/path" (no query) and answer with a Response.
 * Anything unrouted answers 404. Every request is kept in `seen`.
 */
export function fakeFetch(routes: Record<string, Handler>): FakeFetch {
  const seen: Seen[] = [];
  const handler = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    let json: unknown;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    const req: Seen = {
      method,
      url,
      headers: new Headers(init?.headers),
      body,
      json,
      form: new URLSearchParams(body),
    };
    seen.push(req);
    const route = routes[`${method} ${url.origin}${url.pathname}`];
    if (!route) return new Response("not found", { status: 404 });
    return route(req);
  };
  return Object.assign(handler, { seen });
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function status(code: number, value: unknown = { error: "failed" }): Response {
  return json(value, { status: code });
}

/** A fetch that never reaches anything. */
export const offline: Fetch = async () => {
  throw new TypeError("fetch failed");
};
