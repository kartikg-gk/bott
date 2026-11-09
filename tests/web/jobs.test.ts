import { afterEach, describe, expect, it } from "vitest";
import { backends } from "../support/fakeD1.ts";
import { gated, Harness } from "./support.ts";

type Json = Record<string, unknown>;

describe.each(backends)("%s backend", (kind) => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  async function start() {
    h = new Harness(kind);
    const db = h.database();
    const gateway = await h.gateway(gated([]), { db });
    const chief = await gateway.store.chief();
    return { gateway, chief, db, call: h.app(gateway).call };
  }

  it("creates a job and shows it without its owner's details", async () => {
    const { chief, call } = await start();
    const created = await call("/api/jobs", {
      method: "POST",
      json: { bot: chief.id, task: " check mail ", when: "every 2h", missed: "skip" },
    });
    expect(created.status).toBe(201);
    const job = (await created.json()) as Json;
    expect(job).toMatchObject({
      task: "check mail",
      spec: "every:7200",
      missed: "skip",
      status: "active",
      botName: chief.name,
    });
    for (const hidden of ["chat", "user", "thread", "actor", "lastAnswer"]) {
      expect(job).not.toHaveProperty(hidden);
    }
    const listed = (await (await call("/api/jobs")).json()) as Json;
    expect(listed).toMatchObject({ automation: true, scheduler: null });
    expect(listed.jobs).toHaveLength(1);
    const details = (await (await call(`/api/jobs/${job.id}`)).json()) as Json;
    expect(details).toMatchObject({ lastAnswer: null, wakeups: [] });
  });

  it("refuses unclear jobs", async () => {
    const { gateway, chief, call } = await start();
    const temp = await gateway.store.createBot({ name: "T", role: "x", temporary: true });
    const cases: Json[] = [
      { bot: chief.id, task: "x" },
      { bot: chief.id, task: "x", when: "sometimes" },
      { bot: chief.id, task: "  ", when: "every 1h" },
      { bot: temp.id, task: "x", when: "every 1h" },
      { bot: chief.id, task: "x", when: "every 1h", extra: true },
    ];
    for (const json of cases) {
      expect((await call("/api/jobs", { method: "POST", json })).status).toBe(400);
    }
  });

  it("edits, pauses, resumes and cancels a job", async () => {
    const { chief, call } = await start();
    const { id } = (await (
      await call("/api/jobs", {
        method: "POST",
        json: { bot: chief.id, task: "a", when: "every 1h" },
      })
    ).json()) as Json;
    const edited = await call(`/api/jobs/${id}`, {
      method: "PATCH",
      json: { task: "b", when: "daily 08:30" },
    });
    expect(await edited.json()).toMatchObject({ task: "b", spec: "daily:08:30" });
    expect(await (await call(`/api/jobs/${id}/pause`, { method: "POST" })).json()).toMatchObject({
      status: "paused",
    });
    expect((await call(`/api/jobs/${id}/pause`, { method: "POST" })).status).toBe(409);
    expect(await (await call(`/api/jobs/${id}/resume`, { method: "POST" })).json()).toMatchObject({
      status: "active",
    });
    expect(await (await call(`/api/jobs/${id}/cancel`, { method: "POST" })).json()).toMatchObject({
      status: "cancelled",
    });
    expect((await call(`/api/jobs/${id}`, { method: "PATCH", json: { task: "c" } })).status).toBe(
      409,
    );
    expect((await call(`/api/jobs/${id}/delete`, { method: "POST" })).status).toBe(404);
  });

  it("keeps one person's jobs from another", async () => {
    const { chief, db, call } = await start();
    const { id } = (await (
      await call("/api/jobs", {
        method: "POST",
        json: { bot: chief.id, task: "a", when: "every 1h" },
      })
    ).json()) as Json;
    const other = h.app(await h.gateway(gated([]), { db, actor: 2 })).call;
    expect((await other(`/api/jobs/${id}`)).status).toBe(404);
    expect((await other(`/api/jobs/${id}/cancel`, { method: "POST" })).status).toBe(404);
    expect(((await (await other("/api/jobs")).json()) as Json).jobs).toEqual([]);
    expect((await call("/api/jobs/99999999999999999999")).status).toBe(404);
  });

  it("turns automation off and on, and takes event wake-ups once each", async () => {
    const { chief, call } = await start();
    await call("/api/jobs", {
      method: "POST",
      json: { bot: chief.id, task: "react", when: "on build.done" },
    });
    const wake = (delivery: string) =>
      call("/api/jobs/events", { method: "POST", json: { event: "build.done", delivery } });
    const first = await wake("d-1");
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "queued", accepted: true });
    expect(await (await wake("d-1")).json()).toEqual({ status: "duplicate", accepted: false });
    expect(
      (
        await call("/api/jobs/events", {
          method: "POST",
          json: { event: "Bad Name!", delivery: "x" },
        })
      ).status,
    ).toBe(400);

    for (const json of [{ enabled: "yes" }, { enabled: true, more: 1 }]) {
      expect((await call("/api/jobs/automation", { method: "PUT", json })).status).toBe(400);
    }
    const off = await call("/api/jobs/automation", { method: "PUT", json: { enabled: false } });
    expect(await off.json()).toEqual({ enabled: false });
    expect(await (await wake("d-2")).json()).toEqual({ status: "off", accepted: false });
  });
});
