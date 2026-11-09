import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystem } from "../../src/agent/instructions.ts";
import { loadSkills, loadSkillsReport, loadSkillTool } from "../../src/agent/skills.ts";

function skillDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "SKILL.md"), text);
  }
  return root;
}

describe("skills", () => {
  it("skills listed by name and loaded on demand", async () => {
    const dir = skillDir({
      deploy: '---\nname: deploy\ndescription: "Ship the app"\n---\n# Deploy\nRun the steps.\n',
      broken: "---\nname: broken\n---\nNo description here.\n",
    });
    const report = loadSkillsReport([dir, join(dir, "missing")]);
    expect(report.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(report.warnings.some((w) => w.includes("broken"))).toBe(true);
    expect(loadSkills([dir]).map((s) => s.description)).toEqual(["Ship the app"]);

    const system = buildSystem({ base: "You help.", skills: report.skills });
    expect(system).toContain("deploy: Ship the app");
    expect(system).not.toContain("Run the steps.");

    const tool = loadSkillTool(report.skills);
    expect(tool.readOnly).toBe(true);
    const signal = new AbortController().signal;
    const out = await tool.run({ name: "deploy" }, { signal });
    expect(out.content[0]).toMatchObject({ text: expect.stringContaining("Run the steps.") });
    const miss = await tool.run({ name: "nope" }, { signal });
    expect(miss.isError).toBe(true);
  });

  it("notes and instructions appear in the system prompt", () => {
    const system = buildSystem({
      base: "You are a helpful bot.",
      notes: ["Prefers short answers", "Lives in Pune"],
      skills: [],
      instructions: "Always run the tests.",
    });
    expect(system.startsWith("You are a helpful bot.")).toBe(true);
    expect(system).toContain("- Prefers short answers");
    expect(system).toContain("- Lives in Pune");
    expect(system).toContain("Always run the tests.");
    expect(buildSystem({ base: "Only base." })).toBe("Only base.");
  });
});
