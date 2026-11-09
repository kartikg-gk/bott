import { z } from "zod";
import type { App } from "./app.ts";
import { AppError, bearer, jsonOutput } from "./http.ts";
import { findTool, type RemoteTool, resultData, runRemote } from "./mcp.ts";
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
    "Show the Todoist tools and whether each reads or writes; give a tool name for its input schema.",
    { cursor: text, name: text },
    { optional: "all" },
  ),
  tool("todoist_read_tool", "Use a Todoist tool that todoist_list_tools shows as read.", call, {
    optional: ["arguments"],
  }),
  tool(
    "todoist_write_tool",
    "Use a Todoist tool that todoist_list_tools shows as write; each use needs approval.",
    call,
    { optional: ["arguments"], write: true, review: true },
  ),
];

export function accessMode(spec: RemoteTool): "read" | "write" {
  const hints = spec.annotations;
  const read =
    READS.has(spec.name) &&
    !!hints &&
    hints.readOnlyHint === true &&
    hints.destructiveHint !== true;
  return read ? "read" : "write";
}

const summary = (spec: RemoteTool) => ({
  name: spec.name,
  mode: accessMode(spec),
  description: (spec.description ?? "").slice(0, 240),
});

export const todoist: App = {
  name: "todoist",
  tools,
  configured: () => false,
  async run(ctx, name, a) {
    const writing = name === "todoist_write_tool";
    const out = await runRemote(
      "Todoist",
      ctx.fetch,
      TODOIST_MCP_URL,
      bearer(await ctx.token()),
      async (client) => {
        if (name === "todoist_list_tools" && !a.name) {
          const page = await client.listTools(a.cursor as string | undefined);
          return { tools: (page.tools ?? []).map(summary), nextCursor: page.nextCursor ?? null };
        }
        const spec = await findTool(client, "Todoist", String(a.name));
        if (name === "todoist_list_tools") {
          return { ...summary(spec), inputSchema: spec.inputSchema ?? null };
        }
        const mode = accessMode(spec);
        if (name !== `todoist_${mode}_tool`) {
          throw new AppError(`Use todoist_${mode}_tool for this operation`);
        }
        const args = (a.arguments ?? {}) as Record<string, unknown>;
        return resultData(await client.callTool(spec.name, args), "Todoist", writing);
      },
      writing,
    );
    return jsonOutput(out);
  },
};
