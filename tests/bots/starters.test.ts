import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkills } from "../../src/agent/skills.ts";
import { ensureStarters, STARTERS } from "../../src/bots/starters.ts";

describe("starter skills", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it("are written once into the state folder and load as skills", () => {
    const state = mkdtempSync(join(tmpdir(), "starters-"));
    folders.push(state);
    const root = ensureStarters(state);
    expect(root).toBe(join(state, "starter-skills"));
    const names = loadSkills([root]).map((skill) => skill.name);
    expect(names.sort()).toEqual(Object.keys(STARTERS).sort());
    expect(names).toEqual(
      expect.arrayContaining(["skill-authoring", "github-issue-review", "gmail-triage"]),
    );
    for (const skill of loadSkills([root])) expect(skill.description.length).toBeGreaterThan(10);
  });

  it("leave a starter the operator changed as it is", () => {
    const state = mkdtempSync(join(tmpdir(), "starters-"));
    folders.push(state);
    const path = join(ensureStarters(state), "gmail-triage", "SKILL.md");
    writeFileSync(path, "---\nname: gmail-triage\ndescription: Mine\n---\nMy own steps.\n");
    ensureStarters(state);
    expect(readFileSync(path, "utf8")).toContain("My own steps.");
  });
});
