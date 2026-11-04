import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { errorOutput, type ToolOutput, type ToolSpec } from "../tools.ts";
import type { Workspace } from "./workspace.ts";

const DEFAULT_READ_LINES = 2000;

const text = (t: string): ToolOutput => ({ content: [{ type: "text", text: t }] });

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolves `given` inside the workspace, following links; null when it leaves. */
async function confine(root: string, given: string): Promise<string | null> {
  const realRoot = await realpath(root);
  let existing = path.resolve(root, given);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(existing);
      const full = path.join(real, ...rest);
      return inside(realRoot, full) ? full : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // A dangling link would be followed on write, so where it leads is unknown.
      const info = await lstat(existing).catch(() => null);
      if (info?.isSymbolicLink()) return null;
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

const outside = (given: string) => errorOutput(`Path is outside the workspace: ${given}`);

const readInput = z.object({
  path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
});
const writeInput = z.object({ path: z.string(), content: z.string() });
const editInput = z.object({
  path: z.string(),
  old_text: z.string().min(1),
  new_text: z.string(),
  replace_all: z.boolean().optional(),
});

export function fileTools(ws: Workspace): ToolSpec[] {
  const read: ToolSpec = {
    name: "Read",
    description:
      "Read a text file in the workspace. Lines are numbered. Returns up to 2000 lines; use offset (1-based line) and limit to page through longer files.",
    input: readInput,
    readOnly: true,
    async run(raw) {
      const input = readInput.parse(raw);
      const file = await confine(ws.root, input.path);
      if (!file) return outside(input.path);
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch (err) {
        return errorOutput(`Cannot read ${input.path}: ${(err as Error).message}`);
      }
      const lines = content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const start = (input.offset ?? 1) - 1;
      const slice = lines.slice(start, start + (input.limit ?? DEFAULT_READ_LINES));
      const body = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
      const more = lines.length - (start + slice.length);
      return text(more > 0 ? `${body}\n[${more} more lines; continue with offset]` : body);
    },
  };

  const write: ToolSpec = {
    name: "Write",
    description:
      "Create or overwrite a file in the workspace with the given content. Parent folders are created.",
    input: writeInput,
    readOnly: false,
    async run(raw) {
      const input = writeInput.parse(raw);
      const file = await confine(ws.root, input.path);
      if (!file) return outside(input.path);
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, input.content, "utf8");
      } catch (err) {
        return errorOutput(`Cannot write ${input.path}: ${(err as Error).message}`);
      }
      return text(`Saved ${input.content.length} characters in ${input.path}`);
    },
  };

  const edit: ToolSpec = {
    name: "Edit",
    description:
      "Replace exact text in a file. old_text must appear once unless replace_all is true.",
    input: editInput,
    readOnly: false,
    async run(raw) {
      const input = editInput.parse(raw);
      const file = await confine(ws.root, input.path);
      if (!file) return outside(input.path);
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch (err) {
        return errorOutput(`Cannot read ${input.path}: ${(err as Error).message}`);
      }
      const count = content.split(input.old_text).length - 1;
      if (count === 0) return errorOutput(`Text not found in ${input.path}`);
      if (count > 1 && !input.replace_all) {
        return errorOutput(
          `Text appears ${count} times in ${input.path}; give more context or set replace_all`,
        );
      }
      await writeFile(file, content.split(input.old_text).join(input.new_text), "utf8");
      return text(`Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${input.path}`);
    },
  };

  return [read, write, edit];
}
