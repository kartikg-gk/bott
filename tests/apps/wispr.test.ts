import { describe, expect, it } from "vitest";
import { AppConnections } from "../../src/apps/connections.ts";
import { MemoryCredentials, MemoryFlows } from "../../src/apps/credentials.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { wispr } from "../../src/apps/wispr.ts";
import { Store } from "../../src/store/store.ts";
import { database } from "../support/fakeD1.ts";
import { fakeFetch, json, status } from "../support/fakeFetch.ts";
import { fakeMcp } from "../support/fakeMcp.ts";

const MCP = "https://api.wisprflow.ai/connect/mcp";
const ISSUER = "https://mcp-auth.wisprflow.com";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));

const discovery = {
  "GET https://api.wisprflow.ai/.well-known/oauth-protected-resource/connect/mcp": () =>
    json({
      resource: MCP,
      authorization_servers: [ISSUER],
      scopes_supported: ["openid", "offline_access"],
    }),
  [`GET ${ISSUER}/.well-known/oauth-authorization-server`]: () =>
    json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth2/authorize`,
      token_endpoint: `${ISSUER}/oauth2/token`,
      registration_endpoint: `${ISSUER}/oauth2/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
};

describe("wispr", () => {
  it("offers only read-only tools", async () => {
    expect(APPS.wispr).toBe(wispr);
    expect(wispr.tools.every((t) => t.readOnly)).toBe(true);
    const mcp = fakeMcp([
      { name: "notes", annotations: null },
      { name: "erase", annotations: { destructiveHint: true } },
      { name: "write", annotations: { readOnlyHint: false } },
    ]);
    const apps = new AppRunner({
      fetch: fakeFetch({ [`POST ${MCP}`]: mcp.post, [`DELETE ${MCP}`]: mcp.remove }),
      env: {},
      accessToken: async () => "w",
      available: async () => true,
    });
    const first = parse(await apps.run("wispr_list_tools", {}));
    expect(first.tools.map((t: { name: string }) => t.name)).toEqual(["notes"]);
    expect(parse(await apps.run("wispr_call_tool", { name: "notes" }))).toEqual({
      text: "done",
      hasOtherContent: false,
    });
    await expect(apps.run("wispr_call_tool", { name: "erase" })).rejects.toThrow(
      "That Wispr Flow tool can change data",
    );
  });

  it("registers a client per account, binds it to the flow, and renews with it", async () => {
    const { db } = database("sqlite");
    const store = await Store.open(db, "main");
    let registered = 0;
    let expired = false;
    const fetcher = fakeFetch({
      ...discovery,
      [`POST ${ISSUER}/oauth2/register`]: (req) => {
        registered += 1;
        return json({ client_id: `client-${registered}`, redirect_uris: req.json.redirect_uris });
      },
      [`POST ${ISSUER}/oauth2/token`]: (req) => {
        if (expired) return status(401, { error: "invalid_client" });
        return json({
          access_token: `w-${req.form.get("grant_type")}`,
          refresh_token: "wr",
          expires_in: 60,
          scope: "openid",
        });
      },
    });
    let now = 1000;
    const credentials = new MemoryCredentials();
    const connections = new AppConnections({
      credentials,
      flows: new MemoryFlows(() => now),
      storeFor: async () => store,
      origin: "https://bott.test",
      fetch: fetcher,
      env: {},
      clock: () => now,
    });
    const caller = { account: "a", session: "s" };
    expect(connections.configured("wispr")).toBe(true);
    const url = new URL((await connections.connect(caller, "wispr")).url);
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("resource")).toBe(MCP);
    expect(url.searchParams.get("scope")).toBe("offline_access openid");
    await connections.connect(caller, "wispr");
    expect(registered).toBe(1);
    expect(JSON.parse((await credentials.get("a", "app-client", "wispr")) as string)).toEqual({
      callback: "https://bott.test/auth/apps/wispr/callback",
      client_id: "client-1",
    });

    const latest = new URL((await connections.connect(caller, "wispr")).url);
    await connections.callback(caller, "wispr", {
      state: latest.searchParams.get("state"),
      code: "c",
    });
    const exchange = fetcher.seen.at(-1);
    expect(exchange?.form.get("client_id")).toBe("client-1");
    expect(exchange?.form.get("resource")).toBe(MCP);
    expect(exchange?.form.has("client_secret")).toBe(false);
    const saved = JSON.parse((await credentials.get("a", "app", "wispr")) as string);
    expect(saved).toMatchObject({ access: "w-authorization_code", client_id: "client-1" });

    now += 60;
    expect(await connections.token("a", "wispr")).toBe("w-refresh_token");
    expect(fetcher.seen.at(-1)?.form.get("client_id")).toBe("client-1");

    expired = true;
    now += 60;
    await expect(connections.token("a", "wispr")).rejects.toThrow(
      "Wispr Flow dropped this server's client. Connect it again.",
    );
    expect(await credentials.get("a", "app-client", "wispr")).toBeNull();
    expect(await credentials.get("a", "app", "wispr")).toBeNull();
    await db.close();
  });

  it("refuses discovery that names another issuer", async () => {
    const { db } = database("sqlite");
    const store = await Store.open(db, "main");
    const connections = new AppConnections({
      credentials: new MemoryCredentials(),
      flows: new MemoryFlows(),
      storeFor: async () => store,
      origin: "https://bott.test",
      fetch: fakeFetch({
        ...discovery,
        "GET https://api.wisprflow.ai/.well-known/oauth-protected-resource/connect/mcp": () =>
          json({ resource: MCP, authorization_servers: ["https://evil.test"] }),
      }),
      env: {},
    });
    await expect(
      connections.connect({ account: "a", session: "s" }, "wispr"),
    ).rejects.toMatchObject({
      status: 502,
      message: "Wispr Flow would not register a client for this server",
    });
    await db.close();
  });
});
