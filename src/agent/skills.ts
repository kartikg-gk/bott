import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
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

/** Most lines one load_skill call hands back. */
const PAGE_LINES = 400;
/** Most characters one load_skill call hands back. */
const PAGE_CHARS = 16_000;
/** Most files a skill lists for the model. */
const LISTED_FILES = 32;

/** A skill file's path inside its folder, or null when it reaches anywhere else. */
function insideSkill(folder: string, relative: string): string | null {
  const parts = relative.split("/");
  if (relative.includes("\\") || parts.some((p) => !p || p === "." || p === "..")) return null;
  const path = join(folder, ...parts);
  try {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) return null;
    const real = realpathSync(path);
    const top = realpathSync(folder);
    return real.startsWith(top + sep) ? real : null;
  } catch {
    return null;
  }
}

/** The skill's files as the model names them, without links, at most LISTED_FILES. */
function filesOf(folder: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (found.length >= LISTED_FILES) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  walk(folder, "");
  return found.sort();
}

const loadInput = z
  .object({
    name: z.string(),
    file: z.string().optional(),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(PAGE_LINES).optional(),
  })
  .strict();

/**
 * The read-only tool that hands the model a skill's instructions, or one of its other text
 * files, a page of lines at a time.
 */
export function loadSkillTool(skills: Skill[]): ToolSpec {
  return {
    name: "load_skill",
    description:
      "Read a skill listed in the system prompt, by name. Leave out file for its instructions, " +
      "or name one of the files it lists. Long text comes in pages: call again with nextOffset.",
    input: loadInput,
    readOnly: true,
    async run(input) {
      const parsed = loadInput.safeParse(input);
      if (!parsed.success)
        return errorOutput("Give a skill name, and a line offset and limit of 1 to 400.");
      const { name, file = "SKILL.md", offset = 1, limit = 200 } = parsed.data;
      const skill = skills.find((s) => s.name === name);
      if (!skill) return errorOutput(`No skill named ${name}.`);
      const folder = dirname(skill.path);
      let text: string;
      if (file === "SKILL.md") text = skill.body;
      else {
        const path = insideSkill(folder, file);
        if (!path) return errorOutput(`${name} has no file ${file}.`);
        text = readFileSync(path, "utf8");
      }
      const lines = text.split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
      const page: string[] = [];
      let size = 0;
      for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
        if (size + line.length > PAGE_CHARS) {
          if (page.length === 0) return errorOutput(`A line in ${file} is too long to read.`);
          break;
        }
        page.push(line);
        size += line.length + 1;
      }
      const end = offset - 1 + page.length;
      const result = {
        name,
        file,
        offset,
        text: page.join("\n"),
        nextOffset: end < lines.length ? end + 1 : null,
        files: filesOf(folder),
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  };
}
