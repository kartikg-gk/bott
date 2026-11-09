import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorOutput, type ToolSpec } from "./tools.ts";

export interface Skill {
  name: string;
  description: string;
  path: string;
  body: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Simple `key: value` front matter; anything nested is ignored. */
function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const raw of (match[1] ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(":");
    if (!line || line.startsWith("#") || colon < 1) continue;
    let value = line.slice(colon + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    meta[line.slice(0, colon).trim()] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

/** Skills under each dir (`<dir>/<skill>/SKILL.md`), with a warning for each one skipped. */
export function loadSkillsReport(dirs: string[]): { skills: Skill[]; warnings: string[] } {
  const skills: Skill[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const child of readdirSync(dir).sort()) {
      const path = join(dir, child, "SKILL.md");
      if (!existsSync(path)) continue;
      const { meta, body } = parseFrontMatter(readFileSync(path, "utf8"));
      if (!meta.name || !meta.description) {
        warnings.push(`Skipped ${path}: front matter needs both name and description.`);
        continue;
      }
      if (seen.has(meta.name)) {
        warnings.push(`Skipped ${path}: a skill named ${meta.name} is already loaded.`);
        continue;
      }
      seen.add(meta.name);
      skills.push({ name: meta.name, description: meta.description, path, body: body.trim() });
    }
  }
  return { skills, warnings };
}

export function loadSkills(dirs: string[]): Skill[] {
  return loadSkillsReport(dirs).skills;
}

/** The read-only tool that hands the model a skill's full instructions. */
export function loadSkillTool(skills: Skill[]): ToolSpec {
  return {
    name: "load_skill",
    description: "Load the full instructions of a skill listed in the system prompt, by name.",
    input: z.object({ name: z.string() }),
    readOnly: true,
    async run(input) {
      const { name } = input as { name: string };
      const skill = skills.find((s) => s.name === name);
      if (!skill) return errorOutput(`No skill named ${name}.`);
      return { content: [{ type: "text", text: skill.body }] };
    },
  };
}
