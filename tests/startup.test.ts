import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotApps } from "../src/apps/access.ts";
import { readConfig } from "../src/config.ts";
import { type Server, startServer, tokenProvider } from "../src/startup.ts";
import { KEY } from "./support/accounts.ts";
import { backends, database } from "./support/fakeD1.ts";
import { gated, reply } from "./web/support.ts";

const TOKEN = "a-token-long-enough-for-tests";

describe.each(backends)("%s backend", (kind) => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function folder(): string {
    const root = mkdtempSync(join(tmpdir(), "startup-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
  }

  async function start(env: Record<string, string>): Promise<Server> {
    const { db } = database(kind);
    const server = await startServer(readConfig(env), {
      env,
      db,
      providers: () => gated([reply("hello back")]),
    });
    cleanups.push(() => server.close());
    return server;
  }

  it("serves one person with a token and answers who is signed in", async () => {
    const root = folder();
    const server = await start({ BOTT_STATE_DIR: root, BOTT_WEB_TOKEN: TOKEN });
    const session = await server.handler(new Request("http://localhost/auth/session"));
    expect(await session.json()).toEqual({ mode: "bearer", email: null });
    const refused = await server.handler(new Request("http://localhost/api/bots"));
    expect(refused.status).toBe(401);
    const bots = await server.handler(
      new Request("http://localhost/api/bots", { headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    expect(bots.status).toBe(200);
    const gateways = await server.gateways();
    expect(gateways).toHaveLength(1);
    expect(gateways[0]?.store.ctx.instance).toBe(readConfig({ BOTT_STATE_DIR: root }).instance);
  });

  it("refuses to start in token mode without a long enough token", async () => {
    const env = { BOTT_STATE_DIR: folder(), BOTT_WEB_TOKEN: "short" };
    await expect(startServer(readConfig(env), { env, db: database(kind).db })).rejects.toThrow(
      /BOTT_WEB_TOKEN/,
    );
  });

  it("signs people in with Google, with connected apps, when hosted", async () => {
    const env = {
      BOTT_HOSTED: "1",
      BOTT_INSTANCE: "ab".repeat(16),
      BOTT_STATE_DIR: folder(),
      BOTT_ORIGIN: "https://bott.example.test",
      BOTT_MASTER_KEY: KEY,
      BOTT_GOOGLE_CLIENT_ID: "client",
      BOTT_GOOGLE_CLIENT_SECRET: "secret",
      BOTT_ALLOWED_EMAILS: "alice@example.test",
    };
    const server = await start(env);
    const ask = (path: string, cookie = "") =>
      server.handler(
        new Request(`https://bott.example.test${path}`, {
          headers: { host: "bott.example.test", ...(cookie ? { cookie } : {}) },
        }),
      );
    expect(await (await ask("/auth/session")).json()).toEqual({ mode: "google", email: null });
    expect((await ask("/api/bots")).status).toBe(401);
    const login = await ask("/auth/login");
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);

    // A session made the way a finished sign-in makes one.
    const accounts = server.accounts;
    if (!accounts) throw new Error("no account store");
    const token = await accounts.signIn("alice-subject", "alice@example.test", null);
    const cookie = `gateway_session=${token}`;
    expect(await (await ask("/auth/session", cookie)).json()).toEqual({
      mode: "google",
      email: "alice@example.test",
    });
    const apps = await ask("/api/apps", cookie);
    expect(apps.status).toBe(200);
    const [gateway] = await server.gateways();
    expect(gateway?.sessions.apps).toBeInstanceOf(BotApps);
    expect(gateway?.hosted).toBe(true);
  });

  it("refuses Google mode without the settings it needs", async () => {
    // A server that cannot start closes the database it was given.
    const base = { BOTT_AUTH: "google", BOTT_STATE_DIR: folder(), BOTT_MASTER_KEY: KEY };
    await expect(
      startServer(readConfig(base), { env: base, db: database(kind).db }),
    ).rejects.toThrow(/BOTT_ORIGIN/);
    const noClient = { ...base, BOTT_ORIGIN: "http://localhost:8765" };
    await expect(
      startServer(readConfig(noClient), { env: noClient, db: database(kind).db }),
    ).rejects.toThrow(/BOTT_GOOGLE_CLIENT_ID/);
  });
});

describe("the model provider in token mode", () => {
  it("talks to the configured provider with its key", async () => {
    const seen: string[] = [];
    const config = readConfig({ BOTT_PROVIDER: "openai", BOTT_MODEL: "m" }, { home: tmpdir() });
    const provider = tokenProvider(config, { OPENAI_API_KEY: "sk-test" }, async (input, init) => {
      seen.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
      return new Response("nope", { status: 401 });
    });
    const events = [];
    for await (const event of provider.stream({
      model: "m",
      system: "",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(seen[0]).toBe("https://api.openai.com/v1/chat/completions Bearer sk-test");
    expect(events.at(-1)?.type).toBe("error");
  });

  it("explains what is missing instead of calling anyone", async () => {
    for (const env of [{}, { BOTT_PROVIDER: "anthropic" }]) {
      const config = readConfig(env, { home: tmpdir() });
      const provider = tokenProvider(config, env, async () => {
        throw new Error("no call expected");
      });
      const events = [];
      for await (const event of provider.stream({
        model: "",
        system: "",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      })) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", retryable: false });
      expect((events[0] as { message: string }).message).toMatch(/BOTT_PROVIDER|ANTHROPIC_API_KEY/);
    }
  });
});
