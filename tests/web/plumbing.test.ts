import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../../src/accounts/http.ts";
import { serveNode } from "../../src/server.ts";
import { Router, readJson } from "../../src/web/router.ts";
import { eventStream } from "../../src/web/sse.ts";

describe("router", () => {
  const router = new Router<string>();
  router.add("GET", "/api/runs/:run", async (ctx, _req, params) =>
    Response.json({ ctx, ...params }),
  );
  router.add("POST", "/api/runs/:run/stop", async () => new Response("stopped"));
  router.add("GET", "/api/jobs/:job(\\d+)", async (_c, _r, params) => Response.json(params));

  it("matches a path and hands over its parts", async () => {
    const found = router.match("GET", "/api/runs/abc");
    if (!found || found === "method") throw new Error("no match");
    const response = await found.handler("me", new Request("http://x/"), found.params);
    expect(await response.json()).toEqual({ ctx: "me", run: "abc" });
  });

  it("decodes path parts and keeps a part to one segment", () => {
    const found = router.match("GET", "/api/runs/a%20b");
    expect(found !== null && found !== "method" && found.params).toEqual({ run: "a b" });
    expect(router.match("GET", "/api/runs/a/b")).toBeNull();
  });

  it("tells a wrong method from an unknown path", () => {
    expect(router.match("DELETE", "/api/runs/abc")).toBe("method");
    expect(router.match("GET", "/nothing")).toBeNull();
  });

  it("checks a part against its pattern", () => {
    const found = router.match("GET", "/api/jobs/12");
    expect(found !== null && found !== "method" && found.params).toEqual({ job: "12" });
    expect(router.match("GET", "/api/jobs/x1")).toBeNull();
  });
});

describe("readJson", () => {
  const post = (body: string) => new Request("http://x/", { method: "POST", body });

  it("reads a JSON body", async () => {
    expect(await readJson(post('{"a":1}'))).toEqual({ a: 1 });
  });

  it("refuses text that is not JSON", async () => {
    await expect(readJson(post("{"))).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a body over the size limit", async () => {
    const error = await readJson(post(`"${"x".repeat(50)}"`), 20).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(413);
  });
});

describe("eventStream", () => {
  it("writes what the work sends, then ends", async () => {
    const response = eventStream(async (out) => {
      await out.send("data: one\n\n");
      await out.send("data: two\n\n");
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
  });

  it("tells the work when the reader goes away", async () => {
    let seen: AbortSignal | undefined;
    let release!: () => void;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = eventStream(async (out) => {
      seen = out.signal;
      await out.send(": hello\n\n");
      await new Promise<void>((resolve) => out.signal.addEventListener("abort", () => resolve()));
      release();
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    await ended;
    expect(seen?.aborted).toBe(true);
  });
});

describe("serveNode", () => {
  const open: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((close) => close()));
  });

  it("passes the request through and the response back", async () => {
    const server = await serveNode(
      async (request) =>
        Response.json(
          {
            method: request.method,
            path: new URL(request.url).pathname,
            body: await request.text(),
          },
          { status: 201, headers: { "x-test": "yes" } },
        ),
      { host: "127.0.0.1", port: 0 },
    );
    open.push(server.close);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/x?y=1`, {
      method: "POST",
      body: "hello",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("yes");
    expect(await response.json()).toEqual({ method: "POST", path: "/api/x", body: "hello" });
  });

  it("streams a body as it is written", async () => {
    const server = await serveNode(
      async () =>
        eventStream(async (out) => {
          await out.send("data: a\n\n");
          await new Promise((resolve) => setTimeout(resolve, 20));
          await out.send("data: b\n\n");
        }),
      { host: "127.0.0.1", port: 0 },
    );
    open.push(server.close);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(await response.text()).toBe("data: a\n\ndata: b\n\n");
  });

  it("turns a handler failure into a plain 500", async () => {
    const server = await serveNode(
      async () => {
        throw new Error("secret detail");
      },
      { host: "127.0.0.1", port: 0 },
    );
    open.push(server.close);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret detail");
  });
});
