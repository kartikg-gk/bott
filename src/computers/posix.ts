import { posix } from "node:path";
import { type FileKind, FileProblem, type Workspace } from "../agent/tools/workspace.ts";

/** Runs a `sh` script with its arguments as $1, $2... on the computer, input optional. */
export type Shell = (
  script: string,
  args: string[],
  stdin?: Buffer,
) => Promise<{ code: number | null; stdout: Buffer }>;

/** Exit codes the scripts use to say what they found. */
const MISSING = 3;
const WRONG_KIND = 4;

/** The scripts each file operation sends; kept together so a computer can recognise them. */
export const SCRIPTS = {
  // Both the root and the path are resolved, following every link, even through missing parts.
  realpath:
    'r=$(realpath -m -- "$1" 2>/dev/null) && cd "$r" 2>/dev/null && ' +
    'p=$(realpath -m -- "$2" 2>/dev/null) && printf "%s\\n%s" "$r" "$p"',
  stat: '[ -e "$1" ] || exit 3; stat -L -c "%F|%s|%Y" -- "$1" 2>/dev/null',
  list:
    '[ -e "$1" ] || exit 3; [ -d "$1" ] || exit 4; ' +
    'find "$1" -mindepth 1 -maxdepth 1 -printf "%Y %f\\n" 2>/dev/null',
  check: '[ -e "$1" ] || exit 3; [ -f "$1" ] || exit 4',
  read: '[ -e "$1" ] || exit 3; [ -f "$1" ] || exit 4; cat -- "$1"',
  parent: 'mkdir -p -- "$(dirname -- "$1")"',
  write: 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
} as const;

/** Whether `target` is `root` or inside it, on a POSIX computer. */
export function insidePosix(root: string, target: string): boolean {
  const rel = posix.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !posix.isAbsolute(rel));
}

const kindOf = (letter: string): FileKind =>
  letter === "f" ? "file" : letter === "d" ? "directory" : "other";

/** Throws the problem a check script's exit code names, or a plain failure. */
export function checked(code: number | null, path: string, doing: string): void {
  if (code === 0) return;
  if (code === MISSING) throw new FileProblem("missing", `${path} does not exist`);
  if (code === WRONG_KIND) throw new FileProblem("kind", `${path} is not a file`);
  throw new FileProblem("failed", `Could not ${doing} ${path}`);
}

/** File operations for a computer reached only through its shell. */
export function posixFiles(
  sh: Shell,
  root: string,
): Pick<Workspace, "realpath" | "stat" | "list" | "readFile" | "writeFile"> {
  return {
    async realpath(given) {
      const found = await sh(SCRIPTS.realpath, [root, given]);
      if (found.code !== 0) throw new FileProblem("failed", `Could not resolve ${given}`);
      const [realRoot, full] = found.stdout.toString("utf8").split("\n");
      if (!realRoot || !full) throw new FileProblem("failed", `Could not resolve ${given}`);
      return insidePosix(realRoot, full) ? full : null;
    },
    async stat(path) {
      const found = await sh(SCRIPTS.stat, [path]);
      if (found.code === MISSING) return null;
      checked(found.code, path, "inspect");
      const [kind, size, modified] = found.stdout.toString("utf8").trim().split("|");
      return {
        kind: kind?.includes("regular") ? "file" : kind === "directory" ? "directory" : "other",
        size: Number(size),
        modified: Number(modified),
      };
    },
    async list(path) {
      const found = await sh(SCRIPTS.list, [path]);
      if (found.code === WRONG_KIND) throw new FileProblem("kind", `${path} is not a folder`);
      checked(found.code, path, "list");
      return found.stdout
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ name: line.slice(2), kind: kindOf(line[0] as string) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async readFile(path) {
      const found = await sh(SCRIPTS.read, [path]);
      checked(found.code, path, "read");
      return found.stdout;
    },
    async writeFile(path, data) {
      const found = await sh(SCRIPTS.write, [path], Buffer.from(data));
      checked(found.code, path, "write");
    },
  };
}
