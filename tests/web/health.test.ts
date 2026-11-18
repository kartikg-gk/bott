import { describe, expect, it } from "vitest";
import { createApp, type HealthProbe } from "../../src/web/app.ts";

const SECRET = "s".repeat(43);
// Neither probe below needs a gateway: the health answer never reaches one.
const NO_GATEWAY = {} as never;

function tokenApp(health?: HealthProbe, proxySecret?: string, healthWaitMs?: number) {
  return createApp({
    auth: { mode: "token", token: "t".repeat(20), gateway: NO_GATEWAY },
    proxySecret,
    ...(health ? { health } : {}),
    ...(healthWaitMs === undefined ? {} : { healthWaitMs }),
  });
}

const ask = (handler: (r: Request) => Promise<Response>, init: RequestInit = {}) =>
  handler(new Request("http://127.0.0.1/health", init));

describe("the health answer", () => {
  it("says the server is up and the database answers, without signing in", async () => {
    const handler = tokenApp(async () => ({ schema: "gateway-21" }));
    const response = await ask(handler);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      database: "answers",
      schema: "gateway-21",
    });
    expect((await ask(handler, { method: "HEAD" })).status).toBe(200);
  });

  it("only answers reads", async () => {
    const handler = tokenApp(async () => ({ schema: "gateway-21" }));
    expect((await ask(handler, { method: "POST" })).status).toBe(405);
  });

  it("says the database is down without saying why", async () => {
    const handler = tokenApp(async () => {
      throw new Error("secret-path /home/someone/gateway.sqlite3 is locked");
    });
    const response = await ask(handler);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: "unavailable", database: "does not answer" });
    expect(body).not.toContain("secret-path");
  });

  it("gives up on a database that hangs", async () => {
    const handler = tokenApp(() => new Promise(() => {}), undefined, 20);
    const response = await ask(handler);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ database: "does not answer" });
  });

  it("still asks for the proxy secret when one is set", async () => {
    const handler = tokenApp(async () => ({ schema: "gateway-21" }), SECRET);
    expect((await ask(handler)).status).toBe(403);
    const through = await ask(handler, { headers: { "x-bott-proxy": SECRET } });
    expect(through.status).toBe(200);
  });

  it("answers in Google mode whatever host the probe names", async () => {
    const refusing = {
      requestAllowed: () => false,
      identity: async () => {
        throw new Error("health must not look anyone up");
      },
    };
    const handler = createApp({
      auth: { mode: "google", login: refusing as never, models: {} as never, gateway: NO_GATEWAY },
      health: async () => ({ schema: "gateway-21" }),
    });
    const response = await handler(
      new Request("http://10.0.0.5:3000/health", { headers: { host: "10.0.0.5:3000" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", schema: "gateway-21" });
    // Everything else still goes through the host check.
    expect((await handler(new Request("http://10.0.0.5:3000/auth/session"))).status).toBe(403);
  });
});
