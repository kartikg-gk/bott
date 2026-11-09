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

  it("load_skill pages through the instructions and reads the skill's other files", async () => {
    const body = Array.from({ length: 5 }, (_, i) => `step ${i + 1}`).join("\n");
    const dir = skillDir({ tidy: `---\nname: tidy\ndescription: Tidy up\n---\n${body}\n` });
    mkdirSync(join(dir, "tidy", "guides"));
    writeFileSync(join(dir, "tidy", "guides", "rules.txt"), "one\ntwo\nthree\n");
    const tool = loadSkillTool(loadSkills([dir]));
    const signal = new AbortController().signal;
    const read = async (input: Record<string, unknown>) => {
      const out = await tool.run(input, { signal });
      const first = out.content[0];
      const text = first?.type === "text" ? first.text : "";
      return out.isError ? { error: text } : JSON.parse(text);
    };

    expect(await read({ name: "tidy", limit: 2 })).toEqual({
      name: "tidy",
      file: "SKILL.md",
      offset: 1,
      text: "step 1\nstep 2",
      nextOffset: 3,
      files: ["SKILL.md", "guides/rules.txt"],
    });
    expect(await read({ name: "tidy", offset: 5 })).toMatchObject({
      text: "step 5",
      nextOffset: null,
    });
    expect(await read({ name: "tidy", file: "guides/rules.txt", offset: 2 })).toMatchObject({
      file: "guides/rules.txt",
      text: "two\nthree",
      nextOffset: null,
    });
    for (const file of ["../tidy/SKILL.md", "/etc/passwd", "guides\\rules.txt", "none.txt"]) {
      expect(await read({ name: "tidy", file })).toHaveProperty("error");
    }
    expect(await read({ name: "tidy", limit: 401 })).toHaveProperty("error");
    expect(await read({ name: "tidy", offset: 0 })).toHaveProperty("error");
  });

  it("load_skill stops a page before it grows past 16,000 characters", async () => {
    const long = "x".repeat(9000);
    const dir = skillDir({ big: `---\nname: big\ndescription: Big\n---\n${long}\n${long}\n` });
    const tool = loadSkillTool(loadSkills([dir]));
    const out = await tool.run({ name: "big" }, { signal: new AbortController().signal });
    const page = JSON.parse((out.content[0] as { text: string }).text);
    expect(page.text).toBe(long);
    expect(page.nextOffset).toBe(2);
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
