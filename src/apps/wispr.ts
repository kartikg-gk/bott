import { z } from "zod";
import type { App } from "./app.ts";
import { AppError, bearer, type Fetch, jsonOutput, request } from "./http.ts";
import { findTool, type RemoteTool, resultData, runRemote } from "./mcp.ts";
import { text, tool } from "./schema.ts";

export const WISPR_MCP_URL = "https://api.wisprflow.ai/connect/mcp";
const ISSUER = "https://mcp-auth.wisprflow.com";
export const WISPR_AUTH_URL = `${ISSUER}/oauth2/authorize`;
export const WISPR_TOKEN_URL = `${ISSUER}/oauth2/token`;
const REGISTRATION_URL = `${ISSUER}/oauth2/register`;
const RESOURCE_METADATA =
  "https://api.wisprflow.ai/.well-known/oauth-protected-resource/connect/mcp";
export const WISPR_SCOPES = ["offline_access", "openid"];

const tools = [
  tool(
    "wispr_list_tools",
    "Show the Wispr Flow tools, all read-only; give a tool name for its input schema.",
    { cursor: text, name: text },
    { optional: "all" },
  ),
  tool(
    "wispr_call_tool",
    "Use a Wispr Flow tool found earlier to read notes, meetings or calendar data.",
    { name: text, arguments: z.record(z.string(), z.unknown()) },
    { optional: ["arguments"] },
  ),
];

// biome-ignore lint/suspicious/noExplicitAny: discovery documents are checked field by field
type Item = Record<string, any>;

/**
 * Registers a public OAuth client for this server's callback, after checking that the
 * provider's discovery documents name the expected issuer and endpoints.
 */
export async function registerWisprClient(fetcher: Fetch, callback: string): Promise<string> {
  const resource = await request<Item>(fetcher, "GET", RESOURCE_METADATA, { timeoutMs: 15000 });
  if (
    !resource ||
    resource.resource !== WISPR_MCP_URL ||
    !(resource.authorization_servers ?? []).includes(ISSUER) ||
    !WISPR_SCOPES.every((s) => (resource.scopes_supported ?? []).includes(s))
  ) {
    throw new AppError("Wispr Flow described its resource in an unexpected way");
  }
  const server = await request<Item>(
    fetcher,
    "GET",
    `${ISSUER}/.well-known/oauth-authorization-server`,
    { timeoutMs: 15000 },
  );
  const expected: Item = {
    issuer: ISSUER,
    authorization_endpoint: WISPR_AUTH_URL,
    token_endpoint: WISPR_TOKEN_URL,
    registration_endpoint: REGISTRATION_URL,
  };
  if (
    !server ||
    Object.entries(expected).some(([key, value]) => server[key] !== value) ||
    !(server.code_challenge_methods_supported ?? []).includes("S256") ||
    !(server.token_endpoint_auth_methods_supported ?? []).includes("none")
  ) {
    throw new AppError("Wispr Flow described its authorization in an unexpected way");
  }
  const client = await request<Item>(fetcher, "POST", REGISTRATION_URL, {
    json: {
      client_name: "bott",
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: WISPR_SCOPES.join(" "),
    },
    timeoutMs: 15000,
  });
  const id = client?.client_id;
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 1024 ||
    /\s/.test(id) ||
    (client.token_endpoint_auth_method ?? "none") !== "none" ||
    !(client.redirect_uris ?? [callback]).includes(callback)
  ) {
    throw new AppError("Wispr Flow sent back a client registration that is not valid");
  }
  return id;
}

/** The endpoint is documented as read-only; a tool that says otherwise is refused. */
export function readable(spec: RemoteTool): boolean {
  const hints = spec.annotations;
  return !hints || (hints.readOnlyHint !== false && hints.destructiveHint !== true);
}

const summary = (spec: RemoteTool) => ({
  name: spec.name,
  description: (spec.description ?? "").slice(0, 240),
});

export const wispr: App = {
  name: "wispr",
  tools,
  configured: () => false,
  async run(ctx, name, a) {
    const out = await runRemote(
      "Wispr Flow",
      ctx.fetch,
      WISPR_MCP_URL,
      bearer(await ctx.token()),
      async (client) => {
        if (name === "wispr_list_tools" && !a.name) {
          const page = await client.listTools(a.cursor as string | undefined);
          return {
            tools: (page.tools ?? []).filter(readable).map(summary),
            nextCursor: page.nextCursor ?? null,
          };
        }
        const spec = await findTool(client, "Wispr Flow", String(a.name));
        if (!readable(spec)) throw new AppError("That Wispr Flow tool can change data");
        if (name === "wispr_list_tools") {
          return { ...summary(spec), inputSchema: spec.inputSchema ?? null };
        }
        const args = (a.arguments ?? {}) as Record<string, unknown>;
        return resultData(await client.callTool(spec.name, args), "Wispr Flow");
      },
    );
    return jsonOutput(out);
  },
};
