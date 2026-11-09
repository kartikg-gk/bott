import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../../src/accounts/http.ts";
import {
  AccountModels,
  accountProvider,
  PROVIDERS,
  resolveAccountModel,
} from "../../src/accounts/models.ts";
import { AccountStore } from "../../src/accounts/store.ts";
import type { StreamEvent } from "../../src/agent/providers/types.ts";
import type { Database } from "../../src/db/database.ts";
import { KEY } from "../support/accounts.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

interface Check {
  url: string;
  key: string;
  headers: Headers;
}

/** Answers provider key checks: "invalid" is rejected, "broken" fails, anything else passes. */
function fakeProviders() {
  const checks: Check[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const headers = request.headers;
    const key =
      new URL(request.url).host === "api.anthropic.com"
        ? (headers.get("x-api-key") ?? "")
        : (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    checks.push({ url: request.url, key, headers });
    if (key === "offline") throw new TypeError("fetch failed");
    if (key === "broken") return new Response("", { status: 500 });
    return new Response("{}", { status: key === "invalid" ? 401 : 200 });
  };
  return { checks, fetch };
}

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function fresh(opts: { busy?: () => boolean } = {}) {
    const { db } = database(kind);
    open.push(db);
    const store = await AccountStore.open(db, "realm-1", KEY);
    const providers = fakeProviders();
    const models = new AccountModels(store, { fetch: providers.fetch, ...opts });
    const id = async (subject: string) =>
      String((await store.session(await store.signIn(subject, `${subject}@x.test`, null)))?.id);
    return { store, db, models, id, checks: providers.checks, fetch: providers.fetch };
  }

  const signedIn = async () => true;

  async function refused(promise: Promise<unknown>): Promise<HttpError> {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }

  it("a new account has no model and no keys", async () => {
    const { models, id } = await fresh();
    expect(await models.settings(await id("alice"))).toEqual({
      provider: null,
      model: null,
      keys: [],
    });
  });

  it.each([
    ["openai", "https://api.openai.com/v1/models"],
    ["anthropic", "https://api.anthropic.com/v1/models"],
    ["openrouter", "https://openrouter.ai/api/v1/key"],
  ])("checks a %s key at %s before saving it", async (provider, url) => {
    const { models, id, checks, store } = await fresh();
    const account = await id("alice");
    const saved = await models.save(
      account,
      { provider, model: "test-model", key: "test-provider-key" },
      signedIn,
    );
    expect(saved).toEqual({ provider, model: "test-model", keys: [provider] });
    expect(JSON.stringify(saved)).not.toContain("test-provider-key");
    expect(checks.map((c) => [c.url, c.key])).toEqual([[url, "test-provider-key"]]);
    const [check] = checks;
    if (provider === "anthropic") {
      expect(check?.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(check?.headers.get("authorization")).toBeNull();
    }
    expect(await store.credential(account, "model", provider)).toBe("test-provider-key");
  });

  it("rejected, failing and unreachable checks save nothing", async () => {
    const { models, id, store } = await fresh();
    const account = await id("alice");
    const save = (key: string) =>
      models.save(account, { provider: "openai", model: "m", key }, signedIn);
    expect(await refused(save("invalid"))).toMatchObject({
      status: 400,
      message: "The provider turned this key down",
    });
    expect(await refused(save("broken"))).toMatchObject({
      status: 502,
      message: "The provider was unable to check this key",
    });
    expect(await refused(save("offline"))).toMatchObject({
      status: 502,
      message: "The provider could not be reached to check this key",
    });
    expect(await store.names(account, "model")).toEqual([]);
  });

  it("allows five key checks per person in five minutes", async () => {
    const { models, id, checks } = await fresh();
    const alice = await id("alice");
    const bob = await id("bob");
    const settings = { provider: "openai", model: "fixture", key: "test-alice-secret" };
    for (let i = 0; i < 4; i++) {
      expect(
        (await refused(models.save(alice, { ...settings, key: "invalid" }, signedIn))).status,
      ).toBe(400);
    }
    await models.save(alice, settings, signedIn);
    const limited = await refused(models.save(alice, settings, signedIn));
    expect(limited).toMatchObject({
      status: 429,
      message: "Too many key checks for now; wait five minutes and retry.",
    });
    expect(checks).toHaveLength(5);
    await models.save(bob, settings, signedIn);
    expect(checks).toHaveLength(6);
  });

  it("switches model without a key only to a provider with a saved key", async () => {
    const { models, id, checks } = await fresh();
    const account = await id("alice");
    expect(
      await refused(models.save(account, { provider: "anthropic", model: "m" }, signedIn)),
    ).toMatchObject({ status: 400, message: "Add a key for this provider before choosing it" });
    await models.save(account, { provider: "anthropic", model: "m", key: "k" }, signedIn);
    const changed = await models.save(account, { provider: "anthropic", model: "m2" }, signedIn);
    expect(changed).toEqual({ provider: "anthropic", model: "m2", keys: ["anthropic"] });
    expect(checks).toHaveLength(1);
  });

  it.each([
    [{ provider: "openai", model: "m", key: "k", extra: 1 }, "Invalid model settings"],
    [[], "Invalid model settings"],
    [null, "Invalid model settings"],
    [{ provider: "other", model: "m" }, "Choose an available provider and a valid model ID"],
    [{ provider: "openai", model: " bad" }, "Choose an available provider and a valid model ID"],
    [
      { provider: "openai", model: "x".repeat(201) },
      "Choose an available provider and a valid model ID",
    ],
    [
      { provider: "openai", model: "m", key: "has space" },
      "A key may only hold visible characters and no spaces",
    ],
    [
      { provider: "openai", model: "m", key: "" },
      "A key may only hold visible characters and no spaces",
    ],
    [
      { provider: "openai", model: "m", key: null },
      "A key may only hold visible characters and no spaces",
    ],
  ])("refuses %j", async (body, message) => {
    const { models, id, checks } = await fresh();
    expect(await refused(models.save(await id("alice"), body, signedIn))).toMatchObject({
      status: 400,
      message,
    });
    expect(checks).toEqual([]);
  });

  it("accepts model IDs with the usual punctuation", async () => {
    const { models, id } = await fresh();
    const model = "anthropic/claude-x.1:beta@v2+fast";
    const saved = await models.save(
      await id("alice"),
      { provider: "openrouter", model, key: "k" },
      signedIn,
    );
    expect(saved.model).toBe(model);
  });

  it("refuses changes while bots are working", async () => {
    let busy = true;
    const { models, id, checks } = await fresh({ busy: () => busy });
    const account = await id("alice");
    const body = { provider: "openai", model: "m", key: "k" };
    expect(await refused(models.save(account, body, signedIn))).toMatchObject({
      status: 409,
      message: "Wait until your bots are idle before changing model keys",
    });
    expect(checks).toEqual([]);
    expect((await refused(models.remove(account, "openai"))).status).toBe(409);
    busy = false;
    await models.save(account, body, signedIn);
  });

  it("does not save a key when the session ended during the check", async () => {
    const { models, id, store } = await fresh();
    const account = await id("alice");
    const ended = async () => false;
    expect(
      await refused(models.save(account, { provider: "openai", model: "m", key: "k" }, ended)),
    ).toMatchObject({ status: 401, message: "Sign in again" });
    expect(await store.names(account, "model")).toEqual([]);
  });

  it("removes a key and the selection that used it", async () => {
    const { models, id } = await fresh();
    const account = await id("alice");
    await models.save(account, { provider: "openai", model: "m", key: "k" }, signedIn);
    expect(await models.remove(account, "openai")).toEqual({
      provider: null,
      model: null,
      keys: [],
    });
    expect(await refused(models.remove(account, "nobody"))).toMatchObject({
      status: 404,
      message: "Unknown provider",
    });
  });

  it.each([
    ["anthropic", "https://api.anthropic.com/v1/messages"],
    ["openai", "https://api.openai.com/v1/chat/completions"],
    ["openrouter", "https://openrouter.ai/api/v1/chat/completions"],
  ])("runs with the saved %s key and model", async (provider, endpoint) => {
    const { models, id, store } = await fresh();
    const account = await id("alice");
    await models.save(
      account,
      { provider, model: "test-model", key: "test-provider-key" },
      signedIn,
    );
    const sent: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const modelFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({
        url: request.url,
        body: (await request.json()) as Record<string, unknown>,
        headers: request.headers,
      });
      return new Response("nope", { status: 400 });
    };
    const resolved = await resolveAccountModel(store, account, { fetch: modelFetch });
    expect(resolved).toMatchObject({ name: provider, model: "test-model" });
    expect(resolved.provider.id).toBe(provider);

    const lazy = accountProvider(store, account, { fetch: modelFetch });
    const events: StreamEvent[] = [];
    for await (const event of lazy.stream({
      model: "ignored",
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(sent.map((s) => s.url)).toEqual([endpoint]);
    expect(sent[0]?.body.model).toBe("test-model");
    const header =
      provider === "anthropic"
        ? sent[0]?.headers.get("x-api-key")
        : sent[0]?.headers.get("authorization");
    expect(header).toContain("test-provider-key");
    expect(events.at(-1)?.type).toBe("error");
  });

  it("explains what is missing before a run can use the account's model", async () => {
    const { store, id, db } = await fresh();
    const account = await id("alice");
    await expect(resolveAccountModel(store, account)).rejects.toThrow(
      "Pick a model and add its key under Account settings",
    );
    await db.run("UPDATE accounts SET provider='openai', model='m' WHERE id=?", [account]);
    await expect(resolveAccountModel(store, account)).rejects.toThrow(
      "No model key is saved for this account yet; add one under Account settings",
    );
    const other = await AccountStore.open(db, "another-realm", KEY);
    await store.setModel(account, "openai", "m", "k");
    await expect(resolveAccountModel(other, account)).rejects.toThrow(
      "A saved key would not open with the master key of this server",
    );
  });

  it("lists every available provider", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(["anthropic", "openai", "openrouter"]);
  });
});
