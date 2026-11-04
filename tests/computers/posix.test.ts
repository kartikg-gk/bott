import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/agent/tools/workspace.ts";
import { posixFiles, type Shell } from "../../src/computers/posix.ts";

/** The scripts need a POSIX shell with the usual tools; this machine may not have one. */
function shellReady(): boolean {
  try {
    const probe = spawnSync("sh", ["-c", "command -v readlink && stat -c %s /"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

let base: string;
let root: string;
let files: ReturnType<typeof posixFiles>;

/** Runs scripts under this machine's sh, with `before` put ahead of each one. */
function shellWith(before: string): Shell {
  return async (script, args, stdin) => {
    const result = await capture("sh", ["-c", `${before}${script}`, "sh", ...args], {
      cwd: base,
      stdin,
      timeoutMs: 20_000,
    });
    return { code: result.code, stdout: result.stdout };
  };
}

// The second shell hides the GNU-only helpers, as a busybox image would lack them.
const SHELLS = [
  ["a full shell", ""],
  ["a shell without realpath or find", "realpath() { return 127; }; find() { return 127; }; "],
] as const;

// Every check starts several shells, which is slow on some machines and slower under load.
describe.skipIf(!shellReady()).each(SHELLS)(
  "files reached through %s",
  { timeout: 30_000 },
  (_name, before) => {
    const sh = shellWith(before);

    beforeEach(async () => {
      base = mkdtempSync(join(tmpdir(), "posix-"));
      mkdirSync(join(base, "work"));
      mkdirSync(join(base, "elsewhere"));
      writeFileSync(join(base, "elsewhere", "secret.txt"), "s");
      // The shell's own name for the folder, which may differ from this process's.
      const named = await sh('cd "$1" && pwd', [join(base, "work")]);
      root = named.stdout.toString("utf8").trim();
      files = posixFiles(sh, root);
    });
    afterEach(() => rmSync(base, { recursive: true, force: true }));

    it("resolves paths inside the root and refuses the rest", async () => {
      expect(await files.realpath("a/b.txt")).toBe(`${root}/a/b.txt`);
      expect(await files.realpath(".")).toBe(root);
      expect(await files.realpath("../elsewhere/secret.txt")).toBeNull();
      expect(await files.realpath("/etc/passwd")).toBeNull();
      expect(await files.realpath("a/../../x")).toBeNull();
    });

    it("follows links out of the root to refuse them", async () => {
      try {
        symlinkSync(join(base, "elsewhere"), join(base, "work", "link"), "junction");
      } catch {
        return;
      }
      expect(await files.realpath("link/secret.txt")).toBeNull();
      expect(await files.realpath("link/new.txt")).toBeNull();
    });

    it("writes with parents, reads back, and says what is wrong", async () => {
      const file = (await files.realpath("deep/er/note.txt")) as string;
      await files.writeFile(file, "one\ntwo\n");
      expect((await files.readFile(file)).toString()).toBe("one\ntwo\n");
      await files.writeFile(file, Buffer.from([0, 1, 255]));
      expect([...(await files.readFile(file))]).toEqual([0, 1, 255]);

      await expect(files.readFile(`${root}/nope.txt`)).rejects.toMatchObject({ reason: "missing" });
      await expect(files.readFile(`${root}/deep`)).rejects.toMatchObject({ reason: "kind" });
    });

    it("stats and lists", async () => {
      await files.writeFile(`${root}/b.txt`, "12345");
      await files.writeFile(`${root}/a/x.txt`, "");
      expect(await files.stat(`${root}/b.txt`)).toMatchObject({ kind: "file", size: 5 });
      expect(await files.stat(`${root}/a`)).toMatchObject({ kind: "directory" });
      expect(await files.stat(`${root}/missing`)).toBeNull();
      expect(await files.list(root)).toEqual([
        { name: "a", kind: "directory" },
        { name: "b.txt", kind: "file" },
      ]);
      await files.writeFile(`${root}/a/.hidden`, "h");
      expect(await files.list(`${root}/a`)).toEqual([
        { name: ".hidden", kind: "file" },
        { name: "x.txt", kind: "file" },
      ]);
      await expect(files.list(`${root}/b.txt`)).rejects.toMatchObject({ reason: "kind" });
      await expect(files.list(`${root}/none`)).rejects.toMatchObject({ reason: "missing" });
    });
  },
);

describe("a computer missing a tool file access needs", () => {
  it("is named in the error, and the check runs again after a failure", async () => {
    let calls = 0;
    const lacking: Shell = async () => {
      calls++;
      return { code: 0, stdout: Buffer.from(["missing readlink", "format stat", ""].join("\0")) };
    };
    const files = posixFiles(lacking, "/workspace");
    await expect(files.realpath("a.txt")).rejects.toThrow(
      "This computer has no readlink command, which file access needs",
    );
    await expect(files.readFile("/workspace/a.txt")).rejects.toThrow("readlink");
    expect(calls).toBe(2);
  });

  it("says when stat takes no format", async () => {
    const oldStat: Shell = async () => ({ code: 0, stdout: Buffer.from("format stat\0") });
    await expect(posixFiles(oldStat, "/workspace").stat("/workspace/a")).rejects.toThrow(
      "This computer's stat does not take -c",
    );
  });
});
