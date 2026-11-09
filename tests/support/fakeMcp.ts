import type { RemoteTool } from "../../src/apps/mcp.ts";
import { type Handler, json, type Seen } from "./fakeFetch.ts";

export interface FakeMcp {
  post: Handler;
  remove: Handler;
  calls: { name: string; arguments: unknown; auth: string | null }[];
}

/**
 * A hosted tool server: answers initialize, tools/list (two tools a page) and tools/call. Odd
 * request ids answer as server-sent events, even ones as plain JSON, so both shapes are read.
 */
export function fakeMcp(
  tools: RemoteTool[],
  answer: (name: string, args: unknown) => unknown = () => ({
    content: [{ type: "text", text: "done" }],
  }),
): FakeMcp {
  const calls: FakeMcp["calls"] = [];
  const reply = (id: number, result: unknown) => {
    const message = { jsonrpc: "2.0", id, result };
    if (id % 2 === 1) {
      return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
        headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" },
      });
    }
    return json(message, { headers: { "mcp-session-id": "sess-1" } });
  };
  const post = (req: Seen) => {
    const { id, method, params } = req.json;
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "initialize") return reply(id, { protocolVersion: "2025-06-18" });
    if (req.headers.get("mcp-session-id") !== "sess-1") return new Response(null, { status: 400 });
    if (method === "tools/list") {
      const start = Number(params?.cursor ?? 0);
      const next = start + 2 < tools.length ? String(start + 2) : null;
      return reply(id, { tools: tools.slice(start, start + 2), nextCursor: next });
    }
    if (method === "tools/call") {
      calls.push({
        name: params.name,
        arguments: params.arguments,
        auth: req.headers.get("authorization"),
      });
      return reply(id, answer(params.name, params.arguments));
    }
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
  };
  return { post, remove: () => new Response(null, { status: 204 }), calls };
}
