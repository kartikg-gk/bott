import type { Skill } from "./skills.ts";

export interface SystemParts {
  base: string;
  /** Things remembered about the person, one per line. */
  notes?: string[];
  skills?: Skill[];
  /** Project or bot instructions, included as written. */
  instructions?: string;
}

export function buildSystem({ base, notes, skills, instructions }: SystemParts): string {
  const sections = [base.trim()];
  if (instructions?.trim()) sections.push(`## Instructions\n\n${instructions.trim()}`);
  if (notes?.length) {
    sections.push(`## Notes about the person\n\n${notes.map((n) => `- ${n}`).join("\n")}`);
  }
  if (skills?.length) {
    const lines = [...skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => `- ${s.name}: ${s.description}`);
    sections.push(
      `## Skills\n\nCall load_skill with a name to read its full instructions.\n\n${lines.join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
