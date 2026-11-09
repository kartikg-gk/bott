import { afterEach, describe, expect, it } from "vitest";
import { gated, Harness, reply } from "./support.ts";

const skill = (name: string, description = "Helps with things") =>
  `---\nname: ${name}\ndescription: ${description}\n---\nDo the thing.\n`;

describe("skills and notes", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("saves, lists, reads and deletes shared and bot skills", async () => {
    h = new Harness("sqlite");
    const gateway = await h.gateway(gated([]));
    const { call } = h.app(gateway);
    const ada = await gateway.store.createBot({ name: "Ada", role: "r" });
    const shared = await call("/api/skills", {
      method: "POST",
      json: { name: "tidy", files: { "SKILL.md": skill("tidy"), "docs/more.txt": "extra" } },
    });
    expect(await shared.json()).toEqual({ saved: "tidy" });
    await call(`/api/bots/${ada.id}/skills`, {
      method: "POST",
      json: { name: "papers", files: { "SKILL.md": skill("papers", "Reads papers") } },
    });

    expect(await (await call("/api/skills")).json()).toEqual([
      { name: "tidy", description: "Helps with things", managed: true },
    ]);
    expect(await (await call(`/api/bots/${ada.id}/skills`)).json()).toEqual([
      { name: "papers", description: "Reads papers", managed: true },
      { name: "tidy", description: "Helps with things", managed: false },
    ]);
    expect(await (await call("/api/skills/tidy")).json()).toEqual({
      name: "tidy",
      files: { "SKILL.md": skill("tidy"), "docs/more.txt": "extra" },
    });
    expect(await (await call("/api/skills/tidy", { method: "DELETE" })).json()).toEqual({
      deleted: "tidy",
    });
    expect((await call("/api/skills/tidy")).status).toBe(404);
  });

  it("refuses packages that break the rules", async () => {
    h = new Harness("sqlite");
    const { call } = h.app(await h.gateway(gated([])));
    const bad = [
      { name: "Bad Name", files: { "SKILL.md": skill("Bad Name") } },
      { name: "a", files: { "notes.txt": "no main file" } },
      { name: "a", files: { "SKILL.md": skill("b") } },
      { name: "a", files: { "SKILL.md": "no metadata" } },
      { name: "a", files: { "SKILL.md": skill("a"), "../escape.txt": "x" } },
      { name: "a", files: { "SKILL.md": skill("a"), ".hidden": "x" } },
      { name: "a", files: { "SKILL.md": skill("a"), "big.txt": "x".repeat(256_001) } },
      { name: "a", files: { "SKILL.md": skill("a"), "A.txt": "x", "a.txt": "y" } },
      { name: "a" },
    ];
    for (const json of bad) {
      expect((await call("/api/skills", { method: "POST", json })).status).toBe(400);
    }
    expect((await call("/api/skills/missing", { method: "DELETE" })).status).toBe(400);
  });

  it("reads and writes a bot's notes, and a new skill reaches its next session", async () => {
    h = new Harness("sqlite");
    const provider = gated([reply("ok")]);
    const gateway = await h.gateway(provider);
    const { call } = h.app(gateway);
    const chief = await gateway.store.chief();
    const written = await call(`/api/bots/${chief.id}/memory`, {
      method: "PUT",
      json: { file: "KNOWLEDGE.md", text: "The build runs nightly." },
    });
    expect(await written.json()).toEqual({ saved: "KNOWLEDGE.md" });
    const notes = (await (await call(`/api/bots/${chief.id}/memory`)).json()) as Record<
      string,
      string
    >;
    expect(notes["KNOWLEDGE.md"]).toBe("The build runs nightly.");
    expect(Object.keys(notes)).toEqual(["PREFERENCES.md", "KNOWLEDGE.md"]);
    for (const json of [{ file: "OTHER.md", text: "x" }, { file: "KNOWLEDGE.md" }]) {
      expect((await call(`/api/bots/${chief.id}/memory`, { method: "PUT", json })).status).toBe(
        400,
      );
    }

    await call("/api/skills", {
      method: "POST",
      json: { name: "tidy", files: { "SKILL.md": skill("tidy") } },
    });
    await call("/api/messages", { method: "POST", json: { text: "hi" } });
    await gateway.dispatcher.idle();
    expect(provider.requests[0]?.system).toContain("tidy");
    expect(provider.requests[0]?.system).toContain("The build runs nightly.");
  });
});
