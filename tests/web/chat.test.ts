import { afterEach, describe, expect, it } from "vitest";
import { WEB_CHAT } from "../../src/store/store.ts";
import { backends } from "../support/fakeD1.ts";
import { Gate, gated, Harness, readEvents, reply, toolCall } from "./support.ts";

describe.each(backends)("%s backend", (kind) => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("serves the page without a token and refuses the API without one", async () => {
    h = new Harness(kind);
    const { handler, call } = h.app(await h.gateway(gated([])));
    const page = await handler(new Request("http://127.0.0.1/"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("page");
    const refused = await call("/api/messages", { headers: { authorization: "Bearer wrong" } });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toHaveProperty("error");
    const session = await handler(new Request("http://127.0.0.1/auth/session"));
    expect(await session.json()).toEqual({ mode: "bearer", email: null });
  });

  it("answers unknown paths and wrong methods plainly", async () => {
    h = new Harness(kind);
    const { call } = h.app(await h.gateway(gated([])));
    expect((await call("/api/nothing")).status).toBe(404);
    expect((await call("/api/messages", { method: "DELETE" })).status).toBe(405);
  });

  it("queues a message, runs it and keeps both sides in the history", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([reply("hello there")]));
    const { call } = h.app(gateway);
    const posted = await call("/api/messages", { method: "POST", json: { text: "  hi  " } });
    expect(posted.status).toBe(202);
    await gateway.dispatcher.idle();
    const history = await (await call("/api/messages")).json();
    expect(history).toMatchObject([
      { direction: "in", text: "hi" },
      { direction: "out", text: "hello there" },
    ]);
  });

  it("refuses empty, oversized and malformed messages", async () => {
    h = new Harness(kind);
    const { call } = h.app(await h.gateway(gated([])));
    for (const json of [{ text: "   " }, { text: "x".repeat(16_001) }, { nope: 1 }, [1]]) {
      expect((await call("/api/messages", { method: "POST", json })).status).toBe(400);
    }
    const broken = await call("/api/messages", { method: "POST", body: "{" });
    expect(broken.status).toBe(400);
  });

  it("streams answers and tool activity on the main conversation", async () => {
    h = new Harness(kind);
    const gate = new Gate();
    const provider = gated([toolCall("Read", { path: "notes.txt" }), reply("done")], { 0: gate });
    const gateway = await h.gateway(provider);
    const { call } = h.app(gateway);
    const stream = await call("/api/stream");
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    await call("/api/messages", { method: "POST", json: { text: "read it" } });
    await gate.reached;
    gate.release();
    const records = await readEvents(stream, (seen) => seen.some((r) => r.type === "message"));
    expect(records.filter((r) => r.type === "tool")).toMatchObject([
      { name: "Read", status: "running", path: "notes.txt" },
      { name: "Read" },
    ]);
    expect(records.at(-1)).toMatchObject({ type: "message", text: "done" });
  });

  it("settles an approval for the person who was asked", async () => {
    h = new Harness(kind);
    const provider = gated([toolCall("Write", { path: "a.txt", content: "x" }), reply("ok")]);
    const gateway = await h.gateway(provider, { policy: "ask" });
    const { call } = h.app(gateway);
    const stream = await call("/api/stream");
    await call("/api/messages", { method: "POST", json: { text: "write" } });
    const [card] = (
      await readEvents(stream, (seen) => seen.some((r) => r.type === "approval"))
    ).filter((r) => r.type === "approval");
    expect(card).toMatchObject({ tool: "Write", run: expect.any(String) });
    expect(typeof card?.expires).toBe("number");

    expect(
      (await call("/api/approvals", { method: "POST", json: { id: "x", allow: true } })).status,
    ).toBe(404);
    expect((await call("/api/approvals", { method: "POST", json: { id: 1 } })).status).toBe(400);
    const decided = await call("/api/approvals", {
      method: "POST",
      json: { data: `a:${card?.id}`, allow: true },
    });
    expect(await decided.json()).toEqual({ decided: true });
    await gateway.dispatcher.idle();
    expect((await gateway.store.history(WEB_CHAT, gateway.actor)).at(-1)?.text).toBe("ok");
  });

  it("lists background tasks with their bot's name", async () => {
    h = new Harness(kind);
    const gateway = await h.gateway(gated([]));
    const { call } = h.app(gateway);
    const route = await gateway.store.conversation(WEB_CHAT, gateway.actor);
    const chief = await gateway.store.chief();
    await gateway.store.addTask({
      chat: route.chat,
      user: route.user,
      actor: gateway.actor,
      thread: 0,
      bot: chief.id,
      goal: "g".repeat(300),
      policy: "auto",
      followUp: false,
    });
    const tasks = (await (await call("/api/tasks")).json()) as Record<string, unknown>[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "running", bot: chief.name });
    expect(String(tasks[0]?.goal)).toHaveLength(200);
  });
});

it("serves a placeholder at the root until the interface exists", async () => {
  const { createApp, PLACEHOLDER_PAGE } = await import("../../src/web/app.ts");
  const handler = createApp({
    auth: { mode: "token", token: "t".repeat(20), gateway: {} as never },
  });
  const page = await handler(new Request("http://127.0.0.1/"));
  expect(await page.text()).toBe(PLACEHOLDER_PAGE);
  expect(PLACEHOLDER_PAGE).toContain("on its way");
});
