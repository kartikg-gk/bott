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

/** Finds an advertised tool, following at most 20 pages of the catalog. */
export async function findTool(
  client: RemoteSession,
  provider: string,
  name: string,
): Promise<RemoteTool> {
  let cursor: string | null | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const page = await client.listTools(cursor);
    const found = (page.tools ?? []).find((spec) => spec.name === name);
    if (found) return found;
    cursor = page.nextCursor;
    if (!cursor) throw new AppError(`${provider} did not advertise that tool`);
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw new AppError(`${provider} returned an incomplete tool catalog`);
}

/** What the bot reads from a tool result. */
export function resultData(reply: CallResult, provider: string, mayWrite = false) {
  if (reply.isError) {
    const suffix = mayWrite ? " Look at its state before trying a write again." : "";
    throw new AppError(`${provider} returned a tool error.${suffix}`);
  }
  if (reply.structuredContent !== undefined && reply.structuredContent !== null) {
    return { data: reply.structuredContent };
  }
  const content = reply.content ?? [];
  return {
    text: content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n")
      .slice(0, 18000),
    hasOtherContent: content.some((block) => block.type !== "text"),
  };
}

/**
 * Opens a session, runs `bridge` and closes it, all within 60 seconds. A message meant for the
 * bot passes through; anything else becomes one plain failure.
 */
export async function runRemote<T>(
  provider: string,
  fetcher: Fetch,
  url: string,
  headers: Record<string, string>,
  bridge: (client: RemoteSession) => Promise<T>,
  mayWrite = false,
): Promise<T> {
  const client = new RemoteSession(fetcher, url, headers, AbortSignal.timeout(60000));
  try {
    await client.open();
    return await bridge(client);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const suffix = mayWrite ? " Look first before trying a write again." : "";
    throw new AppError(`${provider} MCP did not confirm the result.${suffix}`);
  } finally {
    await client.close();
  }
}
