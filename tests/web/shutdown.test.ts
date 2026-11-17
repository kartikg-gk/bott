import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { serveNode } from "../../src/server.ts";
import { backends } from "../support/fakeD1.ts";
import { Gate, gated, Harness, reply } from "./support.ts";

describe.each(backends)("%s backend: closing a gateway", (kind) => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("lets a running run finish within the grace and starts nothing new", async () => {
    h = new Harness(kind);
    const gate = new Gate();
    const gateway = await h.gateway(
      gated([reply("finished in time"), reply("never")], { 0: gate }),
    );
    const route = await gateway.journal.route(gateway.actor, null);
    const first = await gateway.queueRun(route, "go", undefined);
    await gateway.dispatch();
    await gate.reached;

    const closed = gateway.close(60_000);
    const second = await gateway.queueRun(route, "too late", undefined);
    await gateway.dispatch();
    gate.release();
    await closed;

    expect(await gateway.journal.status(first.run)).toBe("completed");
    expect(await gateway.journal.status(second.run)).toBe("prompt");
    expect(gateway.working()).toBe(false);
  });

  it("stops a run that outlasts the grace and writes down how it ended", async () => {
    h = new Harness(kind);
    const gate = new Gate();
    const gateway = await h.gateway(gated([reply("never")], { 0: gate }));
    const route = await gateway.journal.route(gateway.actor, null);
    const { run } = await gateway.queueRun(route, "go", undefined);
    await gateway.dispatch();
    await gate.reached;

    await gateway.close(20);
    expect(gateway.working()).toBe(false);
    const status = await gateway.journal.status(run);
    expect(status).toBe("cancelled");
    // Closing again waits for the same close rather than starting another.
    await gateway.close();
  });
});

describe("stopping the HTTP server", () => {
  it("finishes a request under way and takes no new connections", async () => {
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const listening = await serveNode(
      async () => {
        arrived();
        await held;
        return new Response("done");
      },
      { host: "127.0.0.1", port: 0 },
    );
    const address = `http://127.0.0.1:${listening.port}/`;
    const pending = fetch(address);
    await reached;
    listening.stop();
    // A fresh connection is refused once the server stops listening.
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect(listening.port, "127.0.0.1");
      socket.once("error", () => resolve(true));
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
    });
    expect(refused).toBe(true);
    letGo();
    const response = await pending;
    expect(await response.text()).toBe("done");
    await listening.close();
  });
});
