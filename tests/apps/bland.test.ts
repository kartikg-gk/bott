import { describe, expect, it } from "vitest";
import { bland, blandCall } from "../../src/apps/bland.ts";
import { AppConnections } from "../../src/apps/connections.ts";
import { MemoryAttempts, MemoryCredentials, MemoryFlows } from "../../src/apps/credentials.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { Store } from "../../src/store/store.ts";
import { database } from "../support/fakeD1.ts";
import { fakeFetch, json, status } from "../support/fakeFetch.ts";

const CALLS = "https://api.bland.ai/v1/calls";
const KEY = "org_blandkey_1234";
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

describe("bland", () => {
  it("asks before placing a call and reads calls freely", () => {
    expect(APPS.bland).toBe(bland);
    expect(bland.configured({})).toBe(false);
    expect(bland.tools.map((t) => [t.name, t.review])).toEqual([
      ["bland_call", true],
      ["bland_get_call", false],
    ]);
  });

  it("places a call that says it is an AI and records nothing", async () => {
    const { fetcher, apps } = account({
      [`POST ${CALLS}`]: () => json({ status: "success", call_id: "c_1" }),
    });
    const out = parse(
      await apps.run("bland_call", {
        phone_number: "+14155550100",
        task: "Book a table for two.",
        duration_minutes: 5,
      }),
    );
    expect(out).toEqual({ call_id: "c_1", status: "success" });
    const sent = fetcher.seen[0];
    expect(sent?.headers.get("authorization")).toBe(KEY);
    expect(sent?.json).toMatchObject({
      phone_number: "+14155550100",
      max_duration: 5,
      record: false,
    });
    expect(sent?.json.task).toMatch(/^.*AI.*Book a table for two\.$/s);
    await expect(
      apps.run("bland_call", { phone_number: "4155550100", task: "x", duration_minutes: 5 }),
    ).rejects.toThrow("E.164");
    await expect(
      apps.run("bland_call", { phone_number: "+14155550100", task: "x", duration_minutes: 30 }),
    ).rejects.toThrow("15");
  });

  it("says so when the service does not confirm the call", async () => {
    const { apps } = account({ [`POST ${CALLS}`]: () => json({ status: "error" }) });
    await expect(
      apps.run("bland_call", { phone_number: "+14155550100", task: "x", duration_minutes: 1 }),
    ).rejects.toThrow("did not confirm");
  });

  it("reads a call with its summary and a page of transcript", async () => {
    const { apps, fetcher } = account({
      [`GET ${CALLS}/c_1`]: () =>
        json({
          call_id: "c_1",
          status: "completed",
          completed: true,
          price: 1,
          summary: "s".repeat(1000),
          concatenated_transcript: "t".repeat(3000),
        }),
    });
    const first = parse(await apps.run("bland_get_call", { call_id: "c_1" }));
    expect(first).toMatchObject({ call_id: "c_1", status: "completed", nextOffset: 2200 });
    expect(first).not.toHaveProperty("price");
    expect(first.summary).toHaveLength(900);
    expect(first.transcript).toHaveLength(2200);
    const rest = await blandCall(fetcher, KEY, "c_1", 2200);
    expect(rest).toMatchObject({ nextOffset: null });
    await expect(apps.run("bland_get_call", { call_id: "../x" })).rejects.toThrow("ID");
  });

  it("connects with a key that lists calls", async () => {
    const { db } = database("sqlite");
    const store = await Store.open(db, "main");
    const fetcher = fakeFetch({
      [`GET ${CALLS}`]: (req) =>
        req.headers.get("authorization") === KEY ? json({ calls: [] }) : status(401),
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
    await expect(
      connections.saveKey(caller, "bland", { key: "wrong_key_123" }),
    ).rejects.toMatchObject({ status: 422, message: "Bland AI rejected that key" });
    expect(await connections.saveKey(caller, "bland", { key: KEY })).toEqual({ connected: true });
    await db.close();
  });

  it("hands a call's result to the page for a connected account only", async () => {
    const { db } = database("sqlite");
    const store = await Store.open(db, "main");
    const fetcher = fakeFetch({
      [`GET ${CALLS}`]: () => json({ calls: [] }),
      [`GET ${CALLS}/c_1`]: () => json({ call_id: "c_1", status: "completed" }),
      [`GET ${CALLS}/c_down`]: () => status(500),
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
    await expect(connections.blandCall(caller, "c_1", null)).rejects.toMatchObject({
      status: 409,
    });
    await connections.saveKey(caller, "bland", { key: KEY });
    expect(await connections.blandCall(caller, "c_1", null)).toMatchObject({
      call_id: "c_1",
      transcript: "",
      nextOffset: null,
    });
    for (const offset of ["-1", "1e3", "123456789"]) {
      await expect(connections.blandCall(caller, "c_1", offset)).rejects.toMatchObject({
        status: 400,
      });
    }
    await expect(connections.blandCall(caller, "../x", "0")).rejects.toMatchObject({
      status: 400,
    });
    await expect(connections.blandCall(caller, "c_gone", "0")).rejects.toMatchObject({
      status: 404,
    });
    await expect(connections.blandCall(caller, "c_down", "0")).rejects.toMatchObject({
      status: 502,
    });
    await db.close();
  });
});
