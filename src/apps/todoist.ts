import { z } from "zod";
import type { App } from "./app.ts";
import { AppError, bearer, jsonOutput } from "./http.ts";
import { HostedServer, type HostedSession, type RemoteTool } from "./mcp.ts";
import { text, tool } from "./schema.ts";

export const TODOIST_MCP_URL = "https://ai.todoist.net/mcp";
export const TODOIST_SCOPE = "data:read_write";

/** Operations the provider documents as reads; a tool also has to say so itself to count. */
const READS = new Set([
  "fetch",
  "fetch-object",
  "find-activity",
  "find-comments",
  "find-completed-tasks",
  "find-filters",
  "find-labels",
  "find-project-collaborators",
  "find-projects",
  "find-reminders",
  "find-sections",
  "find-tasks",
  "find-tasks-by-date",
  "get-overview",
  "get-productivity-stats",
  "get-project-activity-stats",
  "get-project-health",
  "get-user-status",
  "get-workspace-insights",
  "list-workspaces",
  "search",
  "user-info",
  "view-attachment",
]);

const call = { name: text, arguments: z.record(z.string(), z.unknown()) };

const tools = [
  tool(
    "todoist_list_tools",
    "Todoist's own tools, each marked read or write. Name one to get its input schema.",
    { cursor: text, name: text },
    { optional: "all" },
  ),
  tool("todoist_read_tool", "Runs a Todoist tool that todoist_list_tools marks as read.", call, {
    optional: ["arguments"],
  }),
  tool(
    "todoist_write_tool",
    "Runs a Todoist tool that todoist_list_tools marks as write. The person approves each call.",
    call,
    { optional: ["arguments"], write: true, review: true },
  ),
];

/** A tool counts as a read only when it is on the documented list and says so itself. */
export function accessMode(spec: RemoteTool): "read" | "write" {
  const { readOnlyHint, destructiveHint } = spec.annotations ?? {};
  const claimsRead = readOnlyHint === true && destructiveHint !== true;
  return claimsRead && READS.has(spec.name) ? "read" : "write";
}

const server = new HostedServer("Todoist", TODOIST_MCP_URL);

const describe = (spec: RemoteTool) => ({
  name: spec.name,
  mode: accessMode(spec),
  description: (spec.description ?? "").slice(0, 240),
});

type Args = Record<string, unknown>;

/** Runs a named Todoist tool through the matching read or write entry point only. */
const through =
  (mode: "read" | "write") =>
  async (session: HostedSession, a: Args): Promise<unknown> => {
    const spec = await session.lookup(String(a.name));
    const needed = accessMode(spec);
    if (needed !== mode) throw new AppError(`That tool is a ${needed}; call it with todoist_${needed}_tool`);
    return session.invoke(spec, (a.arguments ?? {}) as Args);
  };

const HANDLERS: Record<string, (session: HostedSession, a: Args) => Promise<unknown>> = {
  async todoist_list_tools(session, a) {
    if (a.name) {
      const spec = await session.lookup(String(a.name));
      return { ...describe(spec), inputSchema: spec.inputSchema ?? null };
    }
    const page = await session.catalog(a.cursor as string | undefined);
    return { tools: page.tools.map(describe), nextCursor: page.nextCursor };
  },
  todoist_read_tool: through("read"),
  todoist_write_tool: through("write"),
};

export const todoist: App = {
  name: "todoist",
  tools,
  configured: () => false,
  async run(ctx, name, a) {
    const handle = HANDLERS[name];
    if (!handle) throw new AppError("Unknown tool");
    const headers = bearer(await ctx.token());
    const writing = name === "todoist_write_tool";
    return jsonOutput(await server.use(ctx.fetch, headers, (s) => handle(s, a), writing));
  },
};
