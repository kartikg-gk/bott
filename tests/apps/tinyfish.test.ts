import { describe, expect, it } from "vitest";
import { AppConnections } from "../../src/apps/connections.ts";
import { MemoryAttempts, MemoryCredentials, MemoryFlows } from "../../src/apps/credentials.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { tinyfish } from "../../src/apps/tinyfish.ts";
import { Store } from "../../src/store/store.ts";
import { database } from "../support/fakeD1.ts";
import { fakeFetch, json, status } from "../support/fakeFetch.ts";

const SEARCH = "https://api.search.tinyfish.ai";
const FETCH = "https://api.fetch.tinyfish.ai";
const AGENT = "https://agent.tinyfish.ai/v1";
const KEY = "tf_key_12345678";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));

function account(routes: Parameters<typeof fakeFetch>[0]) {
  const fetcher = fakeFetch(routes);
  const apps = new AppRunner({
    fetch: fetcher,
    env: {},
    accessToken: async () => KEY,
    available: async () => true,
  });
  return { fetcher, apps };
}

describe("tinyfish", () => {
  it("searches freely and asks before anything that spends credits or acts", () => {
    expect(APPS.tinyfish).toBe(tinyfish);
    expect(tinyfish.configured({})).toBe(false);
    expect(tinyfish.tools.map((t) => [t.name, t.review])).toEqual([
      ["tinyfish_search", false],
      ["tinyfish_fetch", true],
      ["tinyfish_agent", true],
      ["tinyfish_get_run", false],
      ["tinyfish_cancel_run", true],
    ]);
  });

  it("searches with the key header and keeps snippets short", async () => {
    const { fetcher, apps } = account({
      [`GET ${SEARCH}/`]: () =>
        json({ results: [{ url: "https://a.example", snippet: "s".repeat(900) }], total: 1 }),
    });
    const out = parse(await apps.run("tinyfish_search", { query: "tea", page: 2 }));
    expect(out.total).toBe(1);
    expect(out.results[0].snippet).toHaveLength(600);
    expect(fetcher.seen[0]?.headers.get("x-api-key")).toBe(KEY);
    expect(fetcher.seen[0]?.headers.get("authorization")).toBeNull();
    expect(fetcher.seen[0]?.url.searchParams.get("query")).toBe("tea");
    expect(fetcher.seen[0]?.url.searchParams.get("page")).toBe("2");
  });

  it("reads a public page a slice at a time and refuses private addresses", async () => {
    const { fetcher, apps } = account({
      [`POST ${FETCH}/`]: () =>
        json({ results: [{ url: "https://a.example", title: "A", text: "x".repeat(3000) }] }),
    });
    const first = parse(await apps.run("tinyfish_fetch", { url: "https://a.example" }));
    expect(first).toMatchObject({ url: "https://a.example", title: "A", nextOffset: 2200 });
    expect(first.text).toHaveLength(2200);
    expect(fetcher.seen[0]?.json).toEqual({ urls: ["https://a.example"], format: "markdown" });
    const rest = parse(
      await apps.run("tinyfish_fetch", { url: "https://a.example", offset: 2200 }),
    );
    expect(rest).toMatchObject({ nextOffset: null });
    expect(rest.text).toHaveLength(800);
    await expect(apps.run("tinyfish_fetch", { url: "http://127.0.0.1/" })).rejects.toThrow(
      "public",
    );
  });

  it("starts, reads and cancels browser runs", async () => {
    const { fetcher, apps } = account({
      [`POST ${AGENT}/automation/run-async`]: () => json({ run_id: "r_1", status: "queued" }),
      [`GET ${AGENT}/runs/r_1`]: () =>
        json({ run_id: "r_1", status: "done", result: { ok: 1 }, cost: 9, steps: [] }),
      [`POST ${AGENT}/runs/r_1/cancel`]: () => json({ run_id: "r_1", status: "cancelled" }),
    });
    const started = await apps.run("tinyfish_agent", {
      url: "https://shop.example",
      goal: "Find the price",
      duration_seconds: 60,
    });
    expect(parse(started)).toEqual({ run_id: "r_1", status: "queued" });
    expect(fetcher.seen[0]?.json).toEqual({
      url: "https://shop.example",
      goal: "Find the price",
      agent_config: { max_duration_seconds: 60 },
    });
    expect(parse(await apps.run("tinyfish_get_run", { run_id: "r_1" }))).toEqual({
      run_id: "r_1",
      status: "done",
      result: { ok: 1 },
    });
    await apps.run("tinyfish_cancel_run", { run_id: "r_1" });
    expect(fetcher.seen[2]?.method).toBe("POST");
    await expect(apps.run("tinyfish_get_run", { run_id: "../x" })).rejects.toThrow("ID");
    await expect(
      apps.run("tinyfish_agent", { url: "https://a.example", goal: "x", duration_seconds: 10 }),
    ).rejects.toThrow("30");
  });

  it("connects with a key that lists runs", async () => {
    const { db } = database("sqlite");
    const store = await Store.open(db, "main");
    const fetcher = fakeFetch({
      [`GET ${AGENT}/runs`]: (req) =>
        req.headers.get("x-api-key") === KEY ? json({ data: [] }) : status(401),
    });
    const connections = new AppConnections({
      credentials: new MemoryCredentials(),
      flows: new MemoryFlows(),
      attempts: new MemoryAttempts(),
      storeFor: async () => store,
      origin: "https://bott.test",
      fetch: fetcher,
      env: {},
    });
    const caller = { account: "a", session: "s" };
    await expect(connections.saveKey(caller, "tinyfish", { key: "short" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      connections.saveKey(caller, "tinyfish", { key: "wrong_key_123" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await connections.saveKey(caller, "tinyfish", { key: KEY })).toEqual({
      connected: true,
    });
    expect(fetcher.seen.at(-1)?.url.searchParams.get("limit")).toBe("1");
    await db.close();
  });
});
