import { describe, expect, it } from "vitest";
import { AppConnections, OAUTH_APPS } from "../../src/apps/connections.ts";
import { MemoryCredentials, MemoryFlows } from "../../src/apps/credentials.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { todoist } from "../../src/apps/todoist.ts";
import { Store } from "../../src/store/store.ts";
import { database } from "../support/fakeD1.ts";
import { fakeFetch, json } from "../support/fakeFetch.ts";
import { fakeMcp } from "../support/fakeMcp.ts";

const MCP = "https://ai.todoist.net/mcp";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));
const read = { readOnlyHint: true, destructiveHint: false };
const TOOLS = [
  {
    name: "find-tasks",
    description: "Find tasks",
    annotations: read,
    inputSchema: { type: "object" },
  },
  { name: "add-tasks", description: "Add tasks", annotations: { readOnlyHint: false } },
  { name: "search", description: "Search, but not marked", annotations: null },
  { name: "delete-object", description: "Delete", annotations: { ...read, destructiveHint: true } },
];

function server(answer?: (name: string, args: unknown) => unknown) {
  const mcp = fakeMcp(TOOLS, answer);
  const fetcher = fakeFetch({ [`POST ${MCP}`]: mcp.post, [`DELETE ${MCP}`]: mcp.remove });
  const apps = new AppRunner({
    fetch: fetcher,
    env: {},
    accessToken: async () => "todo-token",
    available: async () => true,
  });
  return { mcp, fetcher, apps };
}

describe("todoist", () => {
  it("lists tools with a mode that counts as read only when both sides agree", async () => {
    expect(APPS.todoist).toBe(todoist);
    expect(OAUTH_APPS.todoist?.scopes).toEqual(["data:read_write"]);
    const { apps, fetcher } = server();
    const first = parse(await apps.run("todoist_list_tools", {}));
    expect(first).toEqual({
      tools: [
        { name: "find-tasks", mode: "read", description: "Find tasks" },
        { name: "add-tasks", mode: "write", description: "Add tasks" },
      ],
      nextCursor: "2",
    });
    const rest = parse(await apps.run("todoist_list_tools", { cursor: "2" }));
    expect(rest.tools.map((t: { mode: string }) => t.mode)).toEqual(["write", "write"]);
    expect(parse(await apps.run("todoist_list_tools", { name: "find-tasks" }))).toMatchObject({
      inputSchema: { type: "object" },
    });
    expect(fetcher.seen[0]?.headers.get("authorization")).toBe("Bearer todo-token");
    expect(fetcher.seen.some((s) => s.method === "DELETE")).toBe(true);
  });

  it("runs reads and writes only through the matching tool", async () => {
    const { apps, mcp } = server((name) =>
      name === "find-tasks"
        ? { structuredContent: { tasks: [1] } }
        : { content: [{ type: "text", text: "added" }, { type: "image" }] },
    );
    expect(parse(await apps.run("todoist_read_tool", { name: "find-tasks" }))).toEqual({
      data: { tasks: [1] },
    });
    await expect(apps.run("todoist_read_tool", { name: "add-tasks" })).rejects.toThrow(
      "Call todoist_write_tool for this operation",
    );
    await expect(apps.run("todoist_read_tool", { name: "delete-object" })).rejects.toThrow(
      "Call todoist_write_tool",
    );
    expect(
      parse(await apps.run("todoist_write_tool", { name: "add-tasks", arguments: { a: 1 } })),
    ).toEqual({ text: "added", hasOtherContent: true });
    expect(mcp.calls.map((c) => [c.name, c.arguments])).toEqual([
      ["find-tasks", {}],
      ["add-tasks", { a: 1 }],
    ]);
    await expect(apps.run("todoist_read_tool", { name: "missing" })).rejects.toThrow(
      "Todoist did not advertise that tool",
    );
  });

  it("a failed write tells the bot to check before retrying", async () => {
    const { apps } = server(() => ({ isError: true, content: [] }));
    await expect(apps.run("todoist_write_tool", { name: "add-tasks" })).rejects.toThrow(
      "Todoist returned a tool error. Look at its state before trying a write again.",
    );
    const down = new AppRunner({
      fetch: fakeFetch({ [`POST ${MCP}`]: () => new Response("x", { status: 500 }) }),
      env: {},
      accessToken: async () => "t",
      available: async () => true,
    });
    await expect(down.run("todoist_write_tool", { name: "add-tasks" })).rejects.toThrow(
      "Todoist MCP did not confirm the result. Look first before trying a write again.",
    );
  });

  it("connects for the tool server and revokes with the client's Basic auth", async () => {
    const { db } = database("sqlite");
    const store = await Store.open(db, "main");
    const fetcher = fakeFetch({
      "POST https://todoist.com/oauth/access_token": () =>
        json({
          access_token: "td",
          refresh_token: "tr",
          expires_in: 3600,
          scope: "data:read_write",
        }),
      "POST https://todoist.com/api/v1/revoke": () => json({}),
    });
    const connections = new AppConnections({
      credentials: new MemoryCredentials(),
      flows: new MemoryFlows(),
      storeFor: async () => store,
      origin: "https://bott.test",
      fetch: fetcher,
      env: { BOTT_TODOIST_CLIENT_ID: "t-id", BOTT_TODOIST_CLIENT_SECRET: "t-secret" },
    });
    const caller = { account: "a", session: "s" };
    const url = new URL((await connections.connect(caller, "todoist")).url);
    expect(url.searchParams.get("resource")).toBe(MCP);
    expect(url.searchParams.get("scope")).toBe("data:read_write");
    await connections.callback(caller, "todoist", {
      state: url.searchParams.get("state"),
      code: "c",
    });
    expect(fetcher.seen.at(-1)?.form.get("resource")).toBe(MCP);
    expect((await connections.disconnect(caller, "todoist")).providerRevoked).toBe(true);
    expect(fetcher.seen.at(-1)?.form.get("token")).toBe("td");
    await db.close();
  });
});
