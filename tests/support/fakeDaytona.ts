import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeSandbox {
  id: string;
  name: string;
  state: "started" | "stopped";
  networkBlockAll: boolean;
  labels: Record<string, string>;
  snapshot?: string;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
}

export interface Seen {
  method: string;
  path: string;
  body: string;
}

/** What a command run in a sandbox answers. */
export type Executor = (
  command: string,
  cwd: string | undefined,
  sandbox: FakeSandbox,
) => { exitCode: number; result: string } | Promise<{ exitCode: number; result: string }>;

/** Splits a multipart body into its parts, keeping each part's bytes as they were sent. */
function parts(
  body: Buffer,
  contentType: string,
): { name: string; filename?: string; data: Buffer }[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!boundary) return [];
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const found: { name: string; filename?: string; data: Buffer }[] = [];
  let at = body.indexOf(marker);
  while (at !== -1) {
    const start = at + marker.length;
    const next = body.indexOf(marker, start);
    if (next === -1) break;
    const part = body.subarray(start + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("utf8");
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    found.push({ name, filename, data: part.subarray(split + 4) });
    at = next;
  }
  return found;
}

/**
 * A small stand-in for the Daytona service: sandboxes by name, their lifecycle, commands, and
 * file transfer through the toolbox. Every request is kept for checking.
 */
export class FakeDaytona {
  readonly seen: Seen[] = [];
  readonly sandboxes = new Map<string, FakeSandbox>();
  /** Files in every sandbox, by sandbox id and path. */
  readonly files = new Map<string, Map<string, Buffer>>();
  executor: Executor = () => ({ exitCode: 0, result: "" });
  private server: Server | undefined;
  private count = 0;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  add(sandbox: Omit<FakeSandbox, "id" | "labels"> & { labels?: Record<string, string> }) {
    const made = { id: `sb-${++this.count}`, labels: {}, ...sandbox };
    this.sandboxes.set(made.name, made);
    this.files.set(made.id, new Map());
    return made;
  }

  /** Requests other than the event socket, as "METHOD /path". */
  calls(): string[] {
    return this.seen.map((s) => `${s.method} ${s.path}`);
  }

  private find(idOrName: string): FakeSandbox | undefined {
    return [...this.sandboxes.values()].find((s) => s.id === idOrName || s.name === idOrName);
  }

  private dto(sandbox: FakeSandbox) {
    return {
      ...sandbox,
      toolboxProxyUrl: `${this.url}/toolbox`,
      organizationId: "org",
      target: "us",
      user: "daytona",
      env: {},
      public: false,
      cpu: 1,
      gpu: 0,
      memory: 1,
      disk: 1,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;
    const method = req.method ?? "GET";
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const missing = () => send(404, { statusCode: 404, message: "Sandbox not found" });
    // The SDK's event socket is not offered; it falls back to asking.
    if (path.startsWith("/socket.io")) return send(404, { message: "no events here" });
    this.seen.push({ method, path, body: body.toString("utf8") });

    const toolbox = /^\/toolbox\/([^/]+)(\/.*)$/.exec(path);
    if (toolbox) {
      const sandbox = this.find(toolbox[1] as string);
      if (!sandbox) return missing();
      const store = this.files.get(sandbox.id) as Map<string, Buffer>;
      const action = toolbox[2];
      if (action === "/process/execute") {
        const input = JSON.parse(body.toString("utf8")) as { command: string; cwd?: string };
        return send(200, await this.executor(input.command, input.cwd, sandbox));
      }
      if (action === "/files/bulk-upload") {
        const sent = parts(body, String(req.headers["content-type"]));
        for (let i = 0; ; i++) {
          const target = sent.find((p) => p.name === `files[${i}].path`);
          const file = sent.find((p) => p.name === `files[${i}].file`);
          if (!target || !file) break;
          store.set(target.data.toString("utf8"), file.data);
        }
        return send(200, {});
      }
      if (action === "/files/bulk-download") {
        const wanted = (JSON.parse(body.toString("utf8")) as { paths: string[] }).paths;
        const boundary = "fakeboundary";
        const pieces: Buffer[] = [];
        for (const path of wanted) {
          const data = store.get(path);
          const field = data ? "file" : "error";
          const content = data ?? Buffer.from(JSON.stringify({ message: "file not found" }));
          const type = data ? "application/octet-stream" : "application/json";
          pieces.push(
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${path}"\r\nContent-Type: ${type}\r\n\r\n`,
            ),
            content,
            Buffer.from("\r\n"),
          );
        }
        pieces.push(Buffer.from(`--${boundary}--\r\n`));
        res.writeHead(200, { "content-type": `multipart/form-data; boundary=${boundary}` });
        res.end(Buffer.concat(pieces));
        return;
      }
      return send(404, { message: `no toolbox action ${action}` });
    }

    if (method === "POST" && path === "/sandbox") {
      const input = JSON.parse(body.toString("utf8")) as Omit<FakeSandbox, "id" | "state">;
      return send(200, this.dto(this.add({ ...input, state: "started" })));
    }
    const one = /^\/sandbox\/([^/]+)(\/.*)?$/.exec(path);
    if (one) {
      const sandbox = this.find(decodeURIComponent(one[1] as string));
      if (!sandbox) return missing();
      const action = one[2] ?? "";
      if (method === "GET" && action === "") return send(200, this.dto(sandbox));
      if (method === "DELETE" && action === "") {
        this.sandboxes.delete(sandbox.name);
        return send(200, this.dto(sandbox));
      }
      if (action === "/start") sandbox.state = "started";
      if (action === "/stop") sandbox.state = "stopped";
      if (action.startsWith("/autoarchive/")) {
        sandbox.autoArchiveInterval = Number(action.split("/")[2]);
      }
      if (action.startsWith("/autostop/")) {
        sandbox.autoStopInterval = Number(action.split("/")[2]);
      }
      if (action === "/network-settings") {
        Object.assign(sandbox, JSON.parse(body.toString("utf8")) as Partial<FakeSandbox>);
      }
      return send(200, this.dto(sandbox));
    }
    send(404, { message: `nothing at ${path}` });
  }
}
