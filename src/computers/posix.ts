import { posix } from "node:path";
import { type FileKind, FileProblem, type Workspace } from "../agent/tools/workspace.ts";

/** Runs a `sh` script with its arguments as $1, $2... on the computer, input optional. */
export type Shell = (
  script: string,
  args: string[],
  stdin?: Buffer,
) => Promise<{ code: number | null; stdout: Buffer }>;

/** Commands beyond the shell itself that file access calls on. */
export const NEEDED_TOOLS = ["readlink", "stat", "cat", "mkdir"] as const;

/**
 * The scripts file access sends. They keep to POSIX `sh`, test operators and the tools above, so
 * they work under busybox as well as GNU. Output is NUL-separated, since a name may hold a newline.
 */
export const SCRIPTS = {
  // Prints each tool that cannot be found, and whether `stat` understands a format.
  tools:
    'for t in "$@"; do command -v "$t" >/dev/null 2>&1 || printf "missing %s\\0" "$t"; done; ' +
    'stat -c %s / >/dev/null 2>&1 || printf "format stat\\0"',
  // One answer per argument: l and the link's target, d, f or o for what is there, n for nothing.
  probe:
    'for p in "$@"; do if [ -L "$p" ]; then printf "l%s\\0" "$(readlink -- "$p")"; ' +
    'elif [ -d "$p" ]; then printf "d\\0"; elif [ -f "$p" ]; then printf "f\\0"; ' +
    'elif [ -e "$p" ]; then printf "o\\0"; else printf "n\\0"; fi; done',
  size: 'stat -L -c "%s %Y" -- "$1"',
  // Every entry, hidden ones too, without the two dot names; a link is shown as what it leads to.
  list:
    'cd -- "$1" || exit 1; for e in * .[!.]* ..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; ' +
    'if [ -d "$e" ]; then k=d; elif [ -f "$e" ]; then k=f; else k=o; fi; ' +
    'printf "%s%s\\0" "$k" "$e"; done',
  cat: 'cat -- "$1"',
  folder: 'mkdir -p -- "$1"',
  put: 'mkdir -p -- "$1" && cat > "$2"',
} as const;

/** Links followed in one path before it is taken to be a loop. */
const MAX_LINKS = 40;

/** Whether `target` is `root` or inside it, on a POSIX computer. */
export function insidePosix(root: string, target: string): boolean {
  const rel = posix.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !posix.isAbsolute(rel));
}

const KINDS: Record<string, FileKind> = { d: "directory", f: "file" };
const kindOf = (letter: string): FileKind => KINDS[letter] ?? "other";

const fields = (out: Buffer) => out.toString("utf8").split("\0").slice(0, -1);

/** What is at one path, as the probe script reports it. */
type Found = { link: string } | { kind: FileKind } | null;

export interface PosixFiles
  extends Pick<Workspace, "realpath" | "stat" | "list" | "readFile" | "writeFile"> {
  /** Throws unless `path` is an existing plain file. */
  mustBeFile(path: string): Promise<void>;
  /** Makes the folder that will hold `path`. */
  makeParent(path: string): Promise<void>;
}

/** File access for a computer that is reached only through its shell. */
export function posixFiles(sh: Shell, root: string): PosixFiles {
  let toolsChecked: Promise<void> | undefined;

  /** Says once, plainly, when the computer lacks a command file access depends on. */
  function checkTools(): Promise<void> {
    toolsChecked ??= (async () => {
      const found = await sh(SCRIPTS.tools, [...NEEDED_TOOLS]);
      const lacking = fields(found.stdout);
      const missing = lacking.filter((l) => l.startsWith("missing ")).map((l) => l.slice(8));
      if (missing.length > 0) {
        throw new FileProblem(
          "failed",
          `This computer has no ${missing.join(", ")} command, which file access needs; ` +
            "choose an image that includes it",
        );
      }
      if (lacking.includes("format stat")) {
        throw new FileProblem(
          "failed",
          "This computer's stat does not take -c; choose an image with GNU or busybox stat",
        );
      }
    })().catch((err: unknown) => {
      toolsChecked = undefined;
      throw err;
    });
    return toolsChecked;
  }

  async function run(script: string, args: string[], stdin?: Buffer) {
    await checkTools();
    return sh(script, args, stdin);
  }

  async function probe(paths: string[]): Promise<Found[]> {
    const found = await run(SCRIPTS.probe, paths);
    const answers = fields(found.stdout);
    if (found.code !== 0 || answers.length !== paths.length) {
      throw new FileProblem("failed", "The computer did not say what is at those paths");
    }
    return answers.map((a) => {
      if (a.startsWith("l")) return { link: a.slice(1) };
      return a === "n" ? null : { kind: kindOf(a) };
    });
  }

  /**
   * Follows every link in an absolute path, one component at a time, so the result holds no link
   * at all. Parts that do not exist yet are kept as written.
   */
  async function resolve(absolute: string): Promise<string> {
    let parts = posix.normalize(absolute).split("/").filter(Boolean);
    for (let hops = 0; ; ) {
      const prefixes = parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`);
      const found = prefixes.length > 0 ? await probe(prefixes) : [];
      const at = found.findIndex((f) => f === null || "link" in f || f.kind !== "directory");
      const hit = at === -1 ? undefined : found[at];
      if (!hit || !("link" in hit)) return `/${parts.join("/")}`;
      if (++hops > MAX_LINKS) throw new FileProblem("failed", `Too many links in ${absolute}`);
      const base = posix.dirname(prefixes[at] as string);
      const next = posix.resolve(base, hit.link);
      parts = posix
        .normalize(`${next}/${parts.slice(at + 1).join("/")}`)
        .split("/")
        .filter(Boolean);
    }
  }

  async function mustBeFile(path: string): Promise<void> {
    const [found] = await probe([path]);
    if (!found) throw new FileProblem("missing", `${path} does not exist`);
    if (!("kind" in found) || found.kind !== "file") {
      throw new FileProblem("kind", `${path} is not a file`);
    }
  }

  async function makeParent(path: string): Promise<void> {
    const made = await run(SCRIPTS.folder, [posix.dirname(path)]);
    if (made.code !== 0) throw new FileProblem("failed", `No folder could be made for ${path}`);
  }

  return {
    mustBeFile,
    makeParent,
    async realpath(given) {
      const realRoot = await resolve(root);
      const full = await resolve(posix.resolve(realRoot, given));
      return insidePosix(realRoot, full) ? full : null;
    },
    async stat(path) {
      const [found] = await probe([path]);
      if (!found) return null;
      const kind = "kind" in found ? found.kind : "other";
      const sized = await run(SCRIPTS.size, [path]);
      const [size, modified] = sized.stdout.toString("utf8").trim().split(" ");
      if (sized.code !== 0) throw new FileProblem("failed", `${path} could not be measured`);
      return { kind, size: Number(size), modified: Number(modified) };
    },
    async list(path) {
      const [found] = await probe([path]);
      if (!found) throw new FileProblem("missing", `${path} does not exist`);
      if (!("kind" in found) || found.kind !== "directory") {
        throw new FileProblem("kind", `${path} is not a folder`);
      }
      const listed = await run(SCRIPTS.list, [path]);
      if (listed.code !== 0) throw new FileProblem("failed", `${path} could not be listed`);
      return fields(listed.stdout)
        .map((entry) => ({ name: entry.slice(1), kind: kindOf(entry[0] as string) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async readFile(path) {
      await mustBeFile(path);
      const read = await run(SCRIPTS.cat, [path]);
      if (read.code !== 0) throw new FileProblem("failed", `${path} could not be read`);
      return read.stdout;
    },
    async writeFile(path, data) {
      const wrote = await run(SCRIPTS.put, [posix.dirname(path), path], Buffer.from(data));
      if (wrote.code !== 0) throw new FileProblem("failed", `${path} could not be written`);
    },
  };
}
