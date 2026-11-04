import { z } from "zod";
import { scrubbedEnv } from "../policy.ts";
import { errorOutput, type ToolSpec } from "../tools.ts";
import type { Workspace } from "./workspace.ts";

export const OUTPUT_LIMIT = 30_000;
export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 600;

const input = z.object({
  command: z.string().min(1),
  timeout: z.number().positive().optional(),
});

export function shellTool(ws: Workspace): ToolSpec {
  return {
    name: "Bash",
    description:
      "Run a shell command in the workspace and return its combined output. Default timeout 120 seconds; pass timeout (seconds, at most 600) for longer commands. Output beyond 30000 characters is cut.",
    input,
    readOnly: false,
    async run(raw, ctx) {
      const args = input.parse(raw);
      const seconds = Math.min(args.timeout ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);
      const result = await ws.run(args.command, {
        timeoutMs: seconds * 1000,
        signal: ctx.signal,
        env: scrubbedEnv(process.env),
      });
      let out = result.stdout;
      if (result.stderr) out += (out ? "\n" : "") + result.stderr;
      if (out.length > OUTPUT_LIMIT) {
        const more = out.length - OUTPUT_LIMIT;
        out = `${out.slice(0, OUTPUT_LIMIT)}\n[output truncated: ${more} more characters]`;
      }
      if (result.timedOut) {
        const note = `Command timed out after ${seconds}s and was killed.`;
        return errorOutput(out ? `${out}\n${note}` : note);
      }
      if (result.code !== 0) return errorOutput(`Exit code: ${result.code}\n${out}`);
      return { content: [{ type: "text", text: out }] };
    },
  };
}
