import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTH_URL,
  canonicalOrigin,
  checkGoogleBind,
  GoogleLogin,
  KEYS_URL,
  LOGIN_COOKIE,
  SESSION_COOKIE,
  TOKEN_URL,
} from "../../src/accounts/google.ts";
import { HttpError } from "../../src/accounts/http.ts";
import { bearerAllowed, localToken, TOKEN_VARIABLE } from "../../src/accounts/localToken.ts";
import { AccountStore } from "../../src/accounts/store.ts";
import type { Database } from "../../src/db/database.ts";
import { KEY } from "../support/accounts.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

const ORIGIN = "http://localhost:8765";
const CLIENT = "gateway-client.apps.googleusercontent.com";
const NOW = 1_800_000_000;

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function signJwt(claims: Record<string, unknown>, key: KeyObject, header: Record<string, unknown>) {
  const head = b64(JSON.stringify(header));
  const body = b64(JSON.stringify(claims));
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64(signature)}`;
}

/** Google's token and key endpoints, issuing ID tokens signed with a test key. */
function fakeGoogle() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256" };
  const grants = new Map<string, { claims: Record<string, unknown>; challenge: string }>();
  const calls: string[] = [];
  let header: Record<string, unknown> = { alg: "RS256", kid: "fixture-key", typ: "JWT" };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request.url);
    if (request.url === KEYS_URL) {
      return Response.json({ keys: [jwk] }, { headers: { "Cache-Control": "max-age=60" } });
    }
    expect(request.url).toBe(TOKEN_URL);
    expect(request.method).toBe("POST");
    const fields = new URLSearchParams(await request.text());
    expect(fields.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(fields.get("client_secret")).toBe("test-secret");
    expect(fields.get("grant_type")).toBe("authorization_code");
    const grant = grants.get(String(fields.get("code")));
    grants.delete(String(fields.get("code")));
    if (!grant) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const challenge = createHash("sha256")
      .update(String(fields.get("code_verifier")))
      .digest("base64url");
    expect(challenge).toBe(grant.challenge);
    return Response.json({ id_token: signJwt(grant.claims, privateKey, header) });
  };
  return {
    fetch,
    grants,
    calls,
    setHeader: (value: Record<string, unknown>) => {
      header = value;
    },
  };
}

/** A browser that keeps cookies between requests to the sign-in handlers. */
class Browser {
  readonly cookies = new Map<string, string>();

  request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    return new Request(`http://127.0.0.1:9${path}`, {
      method: init.method ?? "GET",
      headers: {
        host: "localhost:8765",
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
        ...init.headers,
      },
    });
  }

  keep(response: Response): Response {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, value] = String(pair).split("=");
      if (/max-age=0/i.test(line)) this.cookies.delete(String(name));
      else this.cookies.set(String(name), String(value));
    }
    return response;
  }
}

async function status(promise: Promise<Response>): Promise<number> {
  try {
    return (await promise).status;
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
}

describe("origins", () => {
  it.each([
    ["https://Gateway.Example.test/", "https://gateway.example.test"],
    ["https://gateway.example.test:443", "https://gateway.example.test"],
    ["https://gateway.example.test:8443", "https://gateway.example.test:8443"],
    ["http://localhost:8765", "http://localhost:8765"],
    ["http://127.0.0.1:80", "http://127.0.0.1"],
    ["http://[::1]:8765", "http://[::1]:8765"],
  ])("%s becomes %s", (value, expected) => {
    expect(canonicalOrigin(value)).toBe(expected);
  });

  it.each([
    "http://gateway.example.test",
    "https://gateway.example.test/path",
    "https://gateway.example.test/?q=1",
    "https://gateway.example.test/#top",
    "https://user:pass@gateway.example.test",
    "ftp://gateway.example.test",
    "",
    "not a url",
  ])("refuses %s", (value) => {
    expect(() => canonicalOrigin(value)).toThrow(
      "Google sign-in needs an HTTPS origin, or HTTP on a loopback address",
    );
  });
});

it("keeps plain HTTP sign-in on loopback", () => {
  expect(() => checkGoogleBind("http://localhost:8765", "127.0.0.1")).not.toThrow();
  expect(() => checkGoogleBind("https://gateway.example.test", "0.0.0.0")).not.toThrow();
  expect(() => checkGoogleBind("http://localhost:8765", "0.0.0.0")).toThrow(
    "Google sign-in over plain HTTP only works when bound to a loopback address",
  );
});

describe("local token", () => {
  it("is read from the environment for local use", () => {
    const token = "t".repeat(16);
    expect(localToken({ [TOKEN_VARIABLE]: token }, { hosted: false })).toBe(token);
    expect(() => localToken({ [TOKEN_VARIABLE]: "short" }, { hosted: false })).toThrow(
      "Set BOTT_WEB_TOKEN to at least 16 characters for the web page",
    );
    expect(() => localToken({}, { hosted: false })).toThrow("at least 16 characters");
  });

  it("is never accepted when hosted", () => {
    expect(() => localToken({ [TOKEN_VARIABLE]: "t".repeat(40) }, { hosted: true })).toThrow(
      "Hosted mode requires Google sign-in",
    );
  });

  it("checks the bearer header exactly", () => {
    const token = "t".repeat(20);
    expect(bearerAllowed(`Bearer ${token}`, token)).toBe(true);
    expect(bearerAllowed(`Bearer ${token}x`, token)).toBe(false);
    expect(bearerAllowed(`bearer ${token}`, token)).toBe(false);
    expect(bearerAllowed(null, token)).toBe(false);
  });
});

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function fresh() {
    const { db } = database(kind);
    open.push(db);
    let now = NOW;
    const store = await AccountStore.open(db, "realm-1", KEY, { clock: () => now });
    const google = fakeGoogle();
    const login = new GoogleLogin(store, {
      origin: ORIGIN,
      clientId: CLIENT,
      clientSecret: "test-secret",
      emails: ["Alice@Example.test"],
      domains: ["team.test"],
      fetch: google.fetch,
      clock: () => now,
    });
    const advance = (seconds: number) => {
      now += seconds;
    };
    return { store, google, login, advance };
  }

  type Fresh = Awaited<ReturnType<typeof fresh>>;

  /** Starts a sign-in and stages the token Google will hand back for it. */
  async function begin(
    { login, google }: Fresh,
    browser: Browser,
    name: string,
    email: string,
    overrides: Record<string, unknown> = {},
  ) {
    const response = browser.keep(await login.start(browser.request("/auth/login")));
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.getSetCookie().join("\n");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const location = String(response.headers.get("location"));
    expect(location.startsWith(`${AUTH_URL}?`)).toBe(true);
    const query = new URL(location).searchParams;
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(query.get("scope")).toBe("openid email");
    expect(query.get("client_id")).toBe(CLIENT);
    const claims = {
      iss: "https://accounts.google.com",
      aud: CLIENT,
      sub: name,
      email,
      email_verified: true,
      nonce: query.get("nonce"),
      iat: NOW,
      exp: NOW + 60,
      ...overrides,
    };
    google.grants.set(name, { claims, challenge: String(query.get("code_challenge")) });
    return `/auth/callback?state=${query.get("state")}&code=${name}`;
  }

  async function signIn(made: Fresh, browser: Browser, name: string, email: string) {
    const response = browser.keep(
      await made.login.callback(browser.request(await begin(made, browser, name, email))),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(true);
    expect(browser.cookies.has(LOGIN_COOKIE)).toBe(false);
    return String(browser.cookies.get(SESSION_COOKIE));
  }

  it("binds the sign-in to its browser and uses it once", async () => {
    const made = await fresh();
    const alice = new Browser();
    const stranger = new Browser();
    const callback = await begin(made, alice, "alice", "alice@example.test");
    expect(await status(made.login.callback(stranger.request(callback)))).toBe(400);
    const done = alice.keep(await made.login.callback(alice.request(callback)));
    expect(done.status).toBe(302);
    expect(done.headers.getSetCookie().join("\n")).toMatch(/gateway_session=.*HttpOnly/);
    expect(await status(made.login.callback(alice.request(callback)))).toBe(400);
    const account = await made.login.identity(alice.cookies.get(SESSION_COOKIE));
    expect(account?.email).toBe("alice@example.test");
  });

  it("signing out revokes the session everywhere", async () => {
    const made = await fresh();
    const alice = new Browser();
    const token = await signIn(made, alice, "alice", "alice@example.test");
    const out = alice.keep(
      await made.login.logout(alice.request("/auth/logout", { method: "POST" })),
    );
    expect(await out.json()).toEqual({ signedOut: true });
    expect(alice.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await made.login.identity(token)).toBeNull();
  });

  it("a second sign-in on the same browser ends the earlier session", async () => {
    const made = await fresh();
    const alice = new Browser();
    const first = await signIn(made, alice, "alice", "alice@example.test");
    const second = await signIn(made, alice, "alice-2", "alice@example.test");
    expect(second).not.toBe(first);
    expect(await made.login.identity(first)).toBeNull();
    expect(await made.login.identity(second)).not.toBeNull();
  });

  it("admits workspace members of an allowed domain", async () => {
    const made = await fresh();
    const bob = new Browser();
    const callback = await begin(made, bob, "bob", "bob@team.test", { hd: "team.test" });
    expect((await made.login.callback(bob.request(callback))).status).toBe(302);
  });

  it.each([
    [{ aud: "wrong-client" }, 401],
    [{ aud: [CLIENT, "other"] }, 401],
    [{ azp: "other-client" }, 401],
    [{ nonce: "wrong-nonce" }, 401],
    [{ iss: "https://evil.test" }, 401],
    [{ exp: NOW - 1 }, 401],
    [{ iat: NOW + 600 }, 401],
    [{ sub: undefined }, 401],
    [{ email_verified: false }, 403],
    [{ email_verified: "true" }, 403],
    [{ email: "stranger@team.test" }, 403],
    [{ email: "eve@team.test", hd: "other.test" }, 403],
    [{ email: "eve@elsewhere.test", hd: "team.test" }, 403],
    [{ sub: "" }, 403],
  ])("refuses a token with %j", async (overrides, expected) => {
    const made = await fresh();
    const browser = new Browser();
    const { email, ...rest } = overrides as Record<string, unknown>;
    const callback = await begin(
      made,
      browser,
      "rejected",
      typeof email === "string" ? email : "alice@example.test",
      rest,
    );
    expect(await status(made.login.callback(browser.request(callback)))).toBe(expected);
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("accepts an audience list naming this client with an authorized party", async () => {
    const made = await fresh();
    const browser = new Browser();
    const callback = await begin(made, browser, "alice", "alice@example.test", {
      aud: [CLIENT, "other"],
      azp: CLIENT,
    });
    expect((await made.login.callback(browser.request(callback))).status).toBe(302);
  });

  it("refuses tokens with another algorithm or an unknown key", async () => {
    const made = await fresh();
    for (const header of [
      { alg: "HS256", kid: "fixture-key" },
      { alg: "RS256", kid: "missing" },
      { alg: "RS256" },
    ]) {
      made.google.setHeader(header);
      const browser = new Browser();
      const callback = await begin(made, browser, "alice", "alice@example.test");
      expect(await status(made.login.callback(browser.request(callback)))).toBe(401);
    }
  });

  it("refuses a declined or unknown code", async () => {
    const made = await fresh();
    const browser = new Browser();
    const callback = await begin(made, browser, "alice", "alice@example.test");
    const state = new URL(`http://x${callback}`).searchParams.get("state");
    expect(
      await status(made.login.callback(browser.request(`/auth/callback?state=${state}`))),
    ).toBe(400);
    const again = await begin(made, browser, "alice", "alice@example.test");
    const unknown = again.replace("code=alice", "code=nobody");
    expect(await status(made.login.callback(browser.request(unknown)))).toBe(401);
  });

  it("keeps Google's signing keys for as long as they may be cached", async () => {
    const made = await fresh();
    for (const name of ["a1", "a2"]) {
      await signIn(made, new Browser(), name, "alice@example.test");
    }
    expect(made.google.calls.filter((url) => url === KEYS_URL)).toHaveLength(1);
  });

  it("an account no longer allowed loses its sessions", async () => {
    const made = await fresh();
    const token = await signIn(made, new Browser(), "alice", "alice@example.test");
    const stricter = new GoogleLogin(made.store, {
      origin: ORIGIN,
      clientId: CLIENT,
      clientSecret: "test-secret",
      emails: [],
      domains: ["team.test"],
    });
    expect(await stricter.identity(token)).toBeNull();
  });

  it("allows only its own host, and writes only from its own origin", async () => {
    const { login } = await fresh();
    const browser = new Browser();
    const at = (method: string, headers: Record<string, string>) =>
      login.requestAllowed(browser.request("/api/bots", { method, headers }));
    expect(at("GET", {})).toBe(true);
    expect(at("GET", { host: "untrusted.test" })).toBe(false);
    expect(at("POST", { origin: "https://other.test" })).toBe(false);
    expect(at("POST", {})).toBe(true);
    const bare = new Request("http://127.0.0.1:9/api/bots", {
      method: "POST",
      headers: { host: "localhost:8765" },
    });
    expect(login.requestAllowed(bare)).toBe(false);
    const read = new Request("http://127.0.0.1:9/api/bots", {
      headers: { host: "localhost:8765" },
    });
    expect(login.requestAllowed(read)).toBe(true);
    const proxied = new Request("http://127.0.0.1:9/api/bots", {
      headers: { host: "internal:3000", origin: ORIGIN },
    });
    expect(login.requestAllowed(proxied)).toBe(false);
    expect(login.requestAllowed(proxied, { trustedProxy: true })).toBe(true);
  });

  it("marks cookies secure on an HTTPS origin and refuses a busy sign-in", async () => {
    const { store } = await fresh();
    const login = new GoogleLogin(store, {
      origin: "https://gateway.example.test",
      clientId: CLIENT,
      clientSecret: "test-secret",
      emails: ["a@example.test"],
      domains: [],
    });
    const response = await login.start(new Request("https://gateway.example.test/auth/login"));
    expect(response.headers.getSetCookie().join("\n")).toContain("Secure");
    const location = new URL(String(response.headers.get("location")));
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://gateway.example.test/auth/callback",
    );
  });

  it("needs a client and someone to admit", async () => {
    const { store } = await fresh();
    const base = {
      origin: ORIGIN,
      clientId: CLIENT,
      clientSecret: "s",
      emails: ["a@x.test"],
      domains: [],
    };
    expect(() => new GoogleLogin(store, { ...base, clientId: "" })).toThrow(
      "Set BOTT_GOOGLE_CLIENT_ID and BOTT_GOOGLE_CLIENT_SECRET",
    );
    expect(() => new GoogleLogin(store, { ...base, emails: [" "] })).toThrow(
      "Set at least one Google address or Workspace domain that may sign in",
    );
  });
});
