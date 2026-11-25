import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../../src/accounts/http.ts";
import { AccountStore } from "../../src/accounts/store.ts";
import { BrowserKeys } from "../../src/browser/keys.ts";
import type { Database } from "../../src/db/database.ts";
import { KEY } from "../support/accounts.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-browser-run-token-xyz";

/** Answers token checks: "bad" tokens get 403, "gone" accounts 404, "down" 500, "off" no answer. */
function fakeCloudflare() {
  const asked: { url: string; auth: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const auth = request.headers.get("authorization");
    asked.push({ url: request.url, auth });
    if (auth?.includes("off")) throw new TypeError("fetch failed");
    if (auth?.includes("bad")) return new Response("{}", { status: 403 });
    if (auth?.includes("gone")) return new Response("{}", { status: 404 });
    if (auth?.includes("down")) return new Response("{}", { status: 500 });
    return new Response("[]", { status: 200 });
  };
  return { asked, fetch };
}

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function fresh() {
    const { db } = database(kind);
    open.push(db);
    const store = await AccountStore.open(db, "realm-1", KEY);
    const cf = fakeCloudflare();
    const keys = new BrowserKeys(store, { fetch: cf.fetch });
    const account = String((await store.session(await store.signIn("s1", "a@x.test", null)))?.id);
    return { store, keys, account, cf };
  }

  const signedIn = async () => true;

  async function status(promise: Promise<unknown>): Promise<number> {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpError);
    return (error as HttpError).status;
  }

  it("starts with no key", async () => {
    const { keys, account } = await fresh();
    expect(await keys.settings(account)).toEqual({ saved: false, accountId: null });
    expect(await keys.load(account)).toBeNull();
  });

  it("checks the token with Cloudflare, then seals it", async () => {
    const { keys, account, cf, store } = await fresh();
    const saved = await keys.save(account, { accountId: CF_ACCOUNT, token: TOKEN }, signedIn);
    expect(saved).toEqual({ saved: true, accountId: CF_ACCOUNT });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(cf.asked).toEqual([
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/browser-run/devtools/session`,
        auth: `Bearer ${TOKEN}`,
      },
    ]);
    expect(await keys.load(account)).toEqual({ accountId: CF_ACCOUNT, token: TOKEN });
    expect(await store.names(account, "browser")).toEqual(["cloudflare"]);
  });

  it("removes the key", async () => {
    const { keys, account } = await fresh();
    await keys.save(account, { accountId: CF_ACCOUNT, token: TOKEN }, signedIn);
    expect(await keys.remove(account)).toEqual({ saved: false, accountId: null });
    expect(await keys.load(account)).toBeNull();
  });

  it.each([
    [{ accountId: "XYZ", token: TOKEN }, 400],
    [{ accountId: CF_ACCOUNT, token: "short" }, 400],
    [{ accountId: CF_ACCOUNT, token: "has a space in the token" }, 400],
    [{ accountId: CF_ACCOUNT, token: TOKEN, extra: 1 }, 400],
    [[], 400],
  ])("refuses a malformed body %#", async (body, code) => {
    const { keys, account, cf } = await fresh();
    expect(await status(keys.save(account, body, signedIn))).toBe(code);
    expect(cf.asked).toHaveLength(0);
  });

  it.each([
    ["bad-token-for-browser-run", 400],
    ["gone-token-for-browser-run", 400],
    ["down-token-for-browser-run", 502],
    ["off-token-for-browser-run", 502],
  ])("does not save %s", async (token, code) => {
    const { keys, account } = await fresh();
    expect(await status(keys.save(account, { accountId: CF_ACCOUNT, token }, signedIn))).toBe(code);
    expect(await keys.load(account)).toBeNull();
  });

  it("does not save after the person signed out during the check", async () => {
    const { keys, account } = await fresh();
    const out = keys.save(account, { accountId: CF_ACCOUNT, token: TOKEN }, async () => false);
    expect(await status(out)).toBe(401);
    expect(await keys.load(account)).toBeNull();
  });

  it("limits how often a key is checked", async () => {
    const { keys, account } = await fresh();
    for (let i = 0; i < 5; i++) {
      await keys.save(account, { accountId: CF_ACCOUNT, token: TOKEN }, signedIn);
    }
    expect(
      await status(keys.save(account, { accountId: CF_ACCOUNT, token: TOKEN }, signedIn)),
    ).toBe(429);
  });
});
