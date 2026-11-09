import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Largest single file and whole package, in bytes. */
export const FILE_LIMIT = 256_000;
export const PACKAGE_LIMIT = 512_000;
/** Files one package may hold, SKILL.md included. */
export const FILE_COUNT = 32;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const META = /^---\s*\n([\s\S]*?)\n---(?:\n|$)/;

/** A skill package that cannot be read or saved; the message says why. */
export class SkillError extends Error {}

export function checkName(name: unknown): string {
  if (typeof name !== "string" || !SKILL_NAME.test(name)) {
    throw new SkillError("A skill name is 1 to 64 lowercase letters, digits or dashes");
  }
  return name;
}

/** Splits a package path into safe parts: relative, forward slashes, no hidden or dot parts. */
export function pathParts(relative: unknown): string[] {
  if (typeof relative !== "string" || !relative || /[\\:\0]/.test(relative)) {
    throw new SkillError("Give each file a relative path inside the skill");
  }
  const parts = relative.split("/");
  for (const part of parts) {
    if (!part || part.startsWith(".") || part !== part.replace(/[ .]+$/, "")) {
      throw new SkillError("Every file must stay inside its skill folder");
    }
  }
  return parts;
}

/** Simple `key: value` metadata at the top of SKILL.md. */
function metadata(text: string): Record<string, string> | null {
  const match = META.exec(text.replaceAll("\r\n", "\n"));
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    let value = line.slice(colon + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    meta[line.slice(0, colon).trim()] = value;
  }
  return meta;
}

/** Checks a package before it is written: names, paths, sizes and SKILL.md's metadata. */
export function checkPackage(name: string, files: unknown): Record<string, string> {
  checkName(name);
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new SkillError("Send the skill's files as an object of path to text");
  }
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length < 1 || entries.length > FILE_COUNT || !("SKILL.md" in files)) {
    throw new SkillError(`A skill holds SKILL.md and at most ${FILE_COUNT - 1} other text files`);
  }
  const seen = new Set<string>();
  let total = 0;
  for (const [path, text] of entries) {
    const folded = path.toLowerCase();
    if (seen.has(folded)) throw new SkillError("Two files may not differ only in case");
    seen.add(folded);
    pathParts(path);
    if (typeof text !== "string" || text.includes("\0")) {
      throw new SkillError("Skill files hold text only");
    }
    const size = Buffer.byteLength(text, "utf8");
    if (size > FILE_LIMIT) throw new SkillError("One skill file is over 256 KB");
    total += size;
  }
  if (total > PACKAGE_LIMIT) throw new SkillError("The skill is over 512 KB in all");
  const meta = metadata((files as Record<string, string>)["SKILL.md"] as string);
  if (!meta) throw new SkillError("SKILL.md must open with name and description metadata");
  if (meta.name !== name) throw new SkillError("SKILL.md's name must be the skill's own name");
  if (!meta.description?.trim()) throw new SkillError("SKILL.md needs a description");
  return files as Record<string, string>;
}

/** A text file of a package, refusing links, oversized files and anything that is not text. */
function readText(path: string): string {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new SkillError("Linked skill files are not opened");
  if (info.size > FILE_LIMIT) throw new SkillError("One skill file is over 256 KB");
  const text = readFileSync(path, "utf8");
  if (text.includes("\0") || text.includes("�")) {
    throw new SkillError("Skill files hold text only");
  }
  return text;
}

/** Skill packages kept as folders under one root. */
export class SkillFolder {
  constructor(readonly root: string) {}

  private folder(name: string): string {
    return join(this.root, checkName(name));
  }

  /** Whether the package is a plain folder here, not a link to one elsewhere. */
  managed(name: string): boolean {
    const path = this.folder(name);
    return existsSync(path) && lstatSync(path).isDirectory();
  }

  read(name: string): Record<string, string> {
    const top = this.folder(name);
    if (!this.managed(name)) throw new SkillError("No such skill package");
    const files: Record<string, string> = {};
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        pathParts(relative);
        if (entry.isSymbolicLink()) throw new SkillError("Linked skill files are not opened");
        if (entry.isDirectory()) walk(join(dir, entry.name), relative);
        else files[relative] = readText(join(dir, entry.name));
        if (Object.keys(files).length > FILE_COUNT) throw new SkillError("The skill is too big");
      }
    };
    walk(top, "");
    return checkPackage(name, files);
  }

  /** Writes the package beside the old one first, then swaps it in. */
  write(name: string, files: unknown): void {
    const checked = checkPackage(name, files);
    mkdirSync(this.root, { recursive: true });
    const stage = mkdtempSync(join(this.root, ".incoming-"));
    const target = this.folder(name);
    const previous = join(this.root, `.outgoing-${name}-${randomUUID()}`);
    try {
      for (const [path, text] of Object.entries(checked)) {
        const file = join(stage, ...pathParts(path));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text, "utf8");
      }
      if (existsSync(target)) renameSync(target, previous);
      try {
        renameSync(stage, target);
      } catch (error) {
        if (existsSync(previous)) renameSync(previous, target);
        throw error;
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
      rmSync(previous, { recursive: true, force: true });
    }
  }

  remove(name: string): void {
    if (!this.managed(name)) throw new SkillError("No such skill package");
    rmSync(this.folder(name), { recursive: true, force: true });
  }
}
