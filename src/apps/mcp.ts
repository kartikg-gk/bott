import { AppError, type Fetch, HttpError, NetworkError } from "./http.ts";

/** A tool a hosted service advertises. */
export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null;
}

export interface CallResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** The service broke the protocol or answered with a protocol error. */
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

const PROTOCOL = "2025-06-18";
const MAX_EVENT = 256000;
const MAX_REPLY = 4 * 1024 * 1024;

/** A small client for one session with a fixed hosted tool server over streamable HTTP. */
export class RemoteSession {
  private session: string | undefined;
  private next = 1;

  constructor(
    private readonly fetcher: Fetch,
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly signal: AbortSignal,
  ) {}

  private async post(body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.headers,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (this.session) {
      headers["mcp-session-id"] = this.session;
      headers["mcp-protocol-version"] = PROTOCOL;
    }
    let reply: Response;
    try {
      reply = await this.fetcher(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        redirect: "manual",
        signal: this.signal,
      });
    } catch {
      throw new NetworkError("Could not reach the tool server");
    }
    if (!reply.ok) throw new HttpError(reply.status);
    return reply;
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    const reply = await this.post({ id, method, params });
    const session = reply.headers.get("mcp-session-id");
    if (session && !this.session) this.session = session;
    const message = await answerTo(reply, id);
    if (message.error) throw new ProtocolError("The tool server answered with an error");
    if (!message.result || typeof message.result !== "object") {
      throw new ProtocolError("The tool server sent no result");
    }
    return message.result as T;
  }

  async open(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "bott", version: "0.1.0" },
    });
    const reply = await this.post({ method: "notifications/initialized" });
    await reply.body?.cancel().catch(() => {});
  }

  listTools(cursor?: string | null): Promise<{ tools: RemoteTool[]; nextCursor?: string | null }> {
    return this.request("tools/list", cursor ? { cursor } : {});
  }

  callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    if (!this.session) return;
    try {
      const reply = await this.fetcher(this.url, {
        method: "DELETE",
        headers: { ...this.headers, "mcp-session-id": this.session },
        signal: AbortSignal.timeout(5000),
      });
      await reply.body?.cancel().catch(() => {});
    } catch {
      // Ending the session is a courtesy; the server expires it anyway.
    }
  }
}

interface Message {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

/** Reads the reply to request `id`, from plain JSON or a stream of server-sent events. */
async function answerTo(reply: Response, id: number): Promise<Message> {
  const kind = reply.headers.get("content-type") ?? "";
  const text = await bounded(reply);
  if (!kind.includes("text/event-stream")) {
    const parsed = parseJson(text);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const found = messages.find((m) => m && typeof m === "object" && m.id === id);
    if (!found) throw new ProtocolError("The tool server did not answer the request");
    return found;
  }
  for (const event of text.split(/\r?\n\r?\n/)) {
    if (event.length > MAX_EVENT)
      throw new ProtocolError("The tool server sent too large an event");
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    const message = parseJson(data);
    if (message && typeof message === "object" && message.id === id) return message;
  }
  throw new ProtocolError("The tool server did not answer the request");
}

async function bounded(reply: Response): Promise<string> {
  const reader = reply.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_REPLY) {
      await reader.cancel().catch(() => {});
      throw new ProtocolError("The tool server sent too large a reply");
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

// biome-ignore lint/suspicious/noExplicitAny: protocol messages are checked where they are read
function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("The tool server sent invalid JSON");
  }
}

const CATALOG_PAGES = 20;
const SESSION_SECONDS = 60;
const TEXT_LIMIT = 18000;

/** One open session as an app sees it: browse the catalog, look up a tool, call it. */
export interface HostedSession {
  catalog(cursor?: string | null): Promise<{ tools: RemoteTool[]; nextCursor: string | null }>;
  lookup(name: string): Promise<RemoteTool>;
  invoke(spec: RemoteTool, args: Record<string, unknown>): Promise<unknown>;
}

/** A fixed hosted tool server that one app talks to, named the way people know it. */
export class HostedServer {
  constructor(
    readonly label: string,
    readonly url: string,
  ) {}

  /**
   * Runs `work` in a fresh session that is closed afterwards, all within one minute. Messages
   * meant for the bot pass through; any other failure becomes one plain message. `mayWrite`
   * adds a warning to look before repeating a call that may already have changed something.
   */
  async use<T>(
    fetcher: Fetch,
    headers: Record<string, string>,
    work: (session: HostedSession) => Promise<T>,
    mayWrite = false,
  ): Promise<T> {
    const wire = new RemoteSession(
      fetcher,
      this.url,
      headers,
      AbortSignal.timeout(SESSION_SECONDS * 1000),
    );
    const look = mayWrite ? " It may have changed something; look before calling it again." : "";
    try {
      await wire.open();
      return await work({
        catalog: async (cursor) => {
          const page = await wire.listTools(cursor);
          return { tools: page.tools ?? [], nextCursor: page.nextCursor ?? null };
        },
        lookup: (name) => this.lookup(wire, name),
        invoke: async (spec, args) => {
          const reply = await wire.callTool(spec.name, args);
          if (reply.isError)
            throw new AppError(`The ${this.label} tool reported a failure.${look}`);
          return readResult(reply);
        },
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(`No clear answer came back from ${this.label}.${look}`);
    } finally {
      await wire.close();
    }
  }

  /** Walks the catalog page by page until the named tool turns up. */
  private async lookup(wire: RemoteSession, name: string): Promise<RemoteTool> {
    const cursors = new Set<string>();
    let cursor: string | null | undefined;
    for (let pages = 0; pages < CATALOG_PAGES; pages++) {
      const page = await wire.listTools(cursor);
      const match = page.tools?.find((spec) => spec.name === name);
      if (match) return match;
      cursor = page.nextCursor;
      if (!cursor) throw new AppError(`${this.label} has no tool by that name`);
      if (cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    throw new AppError(`${this.label}'s tool list did not end, so the tool was not found`);
  }
}

/** The structured result when there is one, otherwise the text parts joined up. */
function readResult(reply: CallResult) {
  const structured = reply.structuredContent;
  if (structured !== undefined && structured !== null) return { data: structured };
  const blocks = reply.content ?? [];
  const texts = blocks.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []));
  return {
    text: texts.join("\n").slice(0, TEXT_LIMIT),
    hasOtherContent: texts.length < blocks.length,
  };
}
