import { HttpError } from "../accounts/http.ts";

/** Answers one request; `params` holds the named parts of the matched path, decoded. */
export type Handler<C> = (
  ctx: C,
  request: Request,
  params: Record<string, string>,
) => Promise<Response>;

interface Entry<C> {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: Handler<C>;
}

/** The largest request body any endpoint reads. */
export const BODY_LIMIT = 2 * 1024 * 1024;

const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * A plain list of routes. A path part written `:name` matches one segment; `:name(regex)`
 * also has to match the regex.
 */
export class Router<C> {
  private readonly entries: Entry<C>[] = [];

  add(method: string, path: string, handler: Handler<C>): this {
    const names: string[] = [];
    const source = path
      .split("/")
      .map((part) => {
        const named = /^:([a-zA-Z]+)(?:\((.+)\))?$/.exec(part);
        if (!named) return part.replace(SPECIAL, "\\$&");
        names.push(named[1] as string);
        return `(${named[2] ?? "[^/]+"})`;
      })
      .join("/");
    this.entries.push({ method, pattern: new RegExp(`^${source}$`), names, handler });
    return this;
  }

  /** The handler for this method and path, "method" when only the method is wrong, or null. */
  match(
    method: string,
    path: string,
  ): { handler: Handler<C>; params: Record<string, string> } | "method" | null {
    let pathOnly = false;
    for (const entry of this.entries) {
      const found = entry.pattern.exec(path);
      if (!found) continue;
      const params: Record<string, string> = {};
      try {
        entry.names.forEach((name, at) => {
          params[name] = decodeURIComponent(found[at + 1] as string);
        });
      } catch {
        continue;
      }
      if (entry.method !== method && !(method === "HEAD" && entry.method === "GET")) {
        pathOnly = true;
        continue;
      }
      return { handler: entry.handler, params };
    }
    return pathOnly ? "method" : null;
  }
}

/** The request body parsed as JSON; a 413 when it is too big, a 400 when it is not JSON. */
export async function readJson(request: Request, limit = BODY_LIMIT): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) throw new HttpError(413, "The request body is too large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > limit) throw new HttpError(413, "The request body is too large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "The request body must be JSON");
  }
}

/** The body as a plain object, or a 400 with `message`. */
export async function readObject(
  request: Request,
  message: string,
): Promise<Record<string, unknown>> {
  const body = await readJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, message);
  }
  return body as Record<string, unknown>;
}

/** A JSON reply that browsers and proxies must not keep. */
export function fresh(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
