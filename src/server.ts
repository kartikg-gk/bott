/**
 * The web server: one request handler for the page and the API. `serveNode` runs it on this
 * machine's HTTP server; a hosted function calls the same handler directly.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export { AccountGateways, type AccountGatewaysOptions } from "./web/accounts.ts";
export {
  type AppOptions,
  createApp as createHandler,
  type GoogleAuth,
  PROXY_HEADER,
  PROXY_SECRET_VARIABLE,
  type TokenAuth,
} from "./web/app.ts";
export { Gateway, type GatewayOptions } from "./web/gateway.ts";

export type RequestHandler = (request: Request) => Promise<Response>;

/** Turns a Node request into a Web one; its signal aborts when the client goes away. */
function toRequest(req: IncomingMessage, res: ServerResponse, host: string): Request {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const hasBody = !["GET", "HEAD"].includes(method);
  return new Request(`http://${req.headers.host ?? host}${req.url ?? "/"}`, {
    method,
    headers,
    signal: controller.signal,
    ...(hasBody
      ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" as const }
      : {}),
  });
}

/** Writes a Web response to Node, streaming its body and stopping when the client leaves. */
async function send(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          res.once("drain", resolve);
          res.once("close", resolve);
        });
      }
    }
  } catch {
    // The client left or the body failed part way; nobody is left to tell.
  }
  res.end();
}

export interface Listening {
  port: number;
  /** Takes no new connections and drops idle ones; requests under way carry on. */
  stop(): void;
  /** Stops, then cuts every connection still open. */
  close(): Promise<void>;
}

/** Serves the handler on Node's HTTP server; port 0 picks a free one. */
export async function serveNode(
  handler: RequestHandler,
  opts: { host: string; port: number },
): Promise<Listening> {
  const server = createServer((req, res) => {
    void (async () => {
      let response: Response;
      try {
        response = await handler(toRequest(req, res, `${opts.host}:${opts.port}`));
      } catch {
        response = Response.json({ error: "The server could not answer" }, { status: 500 });
      }
      await send(response, res);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  let closed: Promise<void> | undefined;
  const stop = () => {
    closed ??= new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
  };
  return {
    port,
    stop,
    close: async () => {
      stop();
      server.closeAllConnections();
      await closed;
    },
  };
}
