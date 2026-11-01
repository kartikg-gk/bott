import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileTools } from "../../src/agent/tools/files.ts";
import { shellTool } from "../../src/agent/tools/shell.ts";
import { localWorkspace, type RunResult, type Workspace } from "../../src/agent/tools/workspace.ts";
import { textOf } from "../../src/agent/transcript.ts";

let root: string;
let outsideDir: string;
const ctx = () => ({ signal: new AbortController().signal });

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "ws-"));
  root = path.join(base, "work");
  outsideDir = path.join(base, "elsewhere");
  mkdirSync(root);
  mkdirSync(outsideDir);
});
afterEach(() => rmSync(path.dirname(root), { recursive: true, force: true }));

function tool(name: string) {
  const found = fileTools(localWorkspace(root)).find((t) => t.name === name);
  if (!found) throw new Error(name);
  return found;
}

describe("file tools", () => {
  it("read write and edit inside the workspace", async () => {
    const w = await tool("Write").run({ path: "a/b.txt", content: "one\ntwo\nthree\n" }, ctx());
    expect(w.isError).toBeUndefined();
    expect(await readFile(path.join(root, "a", "b.txt"), "utf8")).toBe("one\ntwo\nthree\n");

    const r = await tool("Read").run({ path: "a/b.txt" }, ctx());
    expect(textOf(r.content)).toBe("1\tone\n2\ttwo\n3\tthree");
    const page = await tool("Read").run({ path: "a/b.txt", offset: 2, limit: 1 }, ctx());
    expect(textOf(page.content)).toContain("2\ttwo");
    expect(textOf(page.content)).not.toContain("three\n");

    const e = await tool("Edit").run({ path: "a/b.txt", old_text: "two", new_text: "2" }, ctx());
    expect(e.isError).toBeUndefined();
    expect(await readFile(path.join(root, "a", "b.txt"), "utf8")).toBe("one\n2\nthree\n");
    expect(tool("Read").readOnly).toBe(true);
    expect(tool("Write").readOnly).toBe(false);
  });

  it("caps Read at 2000 lines by default", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n");
    writeFileSync(path.join(root, "big.txt"), lines);
    const r = await tool("Read").run({ path: "big.txt" }, ctx());
    expect(textOf(r.content)).toContain("2000\tl1999");
    expect(textOf(r.content)).not.toContain("2001\t");
  });

  it("refuses paths that leave the workspace", async () => {
    writeFileSync(path.join(outsideDir, "secret.txt"), "s");
    for (const given of ["../x", path.join(outsideDir, "secret.txt")]) {
      for (const [name, input] of [
        ["Read", { path: given }],
        ["Write", { path: given, content: "x" }],
        ["Edit", { path: given, old_text: "a", new_text: "b" }],
      ] as const) {
        const r = await tool(name).run(input, ctx());
        expect(r.isError).toBe(true);
        expect(textOf(r.content)).toBe(`Path is outside the workspace: ${given}`);
      }
    }
  });

  it("refuses a directory link pointing out", async () => {
    writeFileSync(path.join(outsideDir, "secret.txt"), "s");
    symlinkSync(outsideDir, path.join(root, "link"), "junction");
    for (const given of ["link/secret.txt", "link/new.txt"]) {
      const r = await tool("Write").run({ path: given, content: "x" }, ctx());
      expect(r.isError).toBe(true);
      expect(textOf(r.content)).toBe(`Path is outside the workspace: ${given}`);
    }
    const read = await tool("Read").run({ path: "link/secret.txt" }, ctx());
    expect(read.isError).toBe(true);
  });

  it("refuses a file symlink pointing out", async (t) => {
    writeFileSync(path.join(outsideDir, "secret.txt"), "s");
    try {
      symlinkSync(path.join(outsideDir, "secret.txt"), path.join(root, "file-link"), "file");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return t.skip();
      throw err;
    }
    for (const name of ["Read", "Write"] as const) {
      const r = await tool(name).run({ path: "file-link", content: "x" }, ctx());
      expect(r.isError).toBe(true);
      expect(textOf(r.content)).toBe("Path is outside the workspace: file-link");
    }
  });

  it("edit fails clearly when the text is not found or not unique", async () => {
    writeFileSync(path.join(root, "f.txt"), "x x y");
    const missing = await tool("Edit").run({ path: "f.txt", old_text: "z", new_text: "q" }, ctx());
    expect(missing.isError).toBe(true);
    expect(textOf(missing.content)).toBe("Text not found in f.txt");
    const dup = await tool("Edit").run({ path: "f.txt", old_text: "x", new_text: "q" }, ctx());
    expect(textOf(dup.content)).toBe(
      "Text appears 2 times in f.txt; give more context or set replace_all",
    );
    const all = await tool("Edit").run(
      { path: "f.txt", old_text: "x", new_text: "q", replace_all: true },
      ctx(),
    );
    expect(all.isError).toBeUndefined();
    expect(await readFile(path.join(root, "f.txt"), "utf8")).toBe("q q y");
  });
});

function fakeWorkspace(result: Partial<RunResult>, seen?: { opts?: unknown }): Workspace {
  return {
    ...localWorkspace(root),
    async run(_command, opts) {
      if (seen) seen.opts = opts;
      return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
    },
  };
}

describe("shell tool", () => {
  it("bash output is capped and the timeout reported", async () => {
    const big = await shellTool(fakeWorkspace({ stdout: "a".repeat(30_050) })).run(
      { command: "x" },
      ctx(),
    );
    const out = textOf(big.content);
    expect(out.startsWith("a".repeat(30_000))).toBe(true);
    expect(out).toContain("[output truncated: 50 more characters]");

    const seen: { opts?: { timeoutMs: number } } = {};
    const slow = await shellTool(fakeWorkspace({ timedOut: true, code: null }, seen)).run(
      { command: "x", timeout: 9999 },
      ctx(),
    );
    expect(slow.isError).toBe(true);
    expect(textOf(slow.content)).toContain("timed out after 600s");
    expect(seen.opts?.timeoutMs).toBe(600_000);

    await shellTool(fakeWorkspace({}, seen)).run({ command: "x" }, ctx());
    expect(seen.opts?.timeoutMs).toBe(120_000);
  });

  it("really stops a command at its timeout", async () => {
    const r = await shellTool(localWorkspace(root)).run(
      { command: "sleep 30", timeout: 0.5 },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(textOf(r.content)).toContain("timed out");
  }, 15_000);

  it("bash gets no secrets in its environment", async () => {
    process.env.OPENAI_API_KEY = "sk-leak";
    process.env.BOTT_FOO = "leak";
    process.env.MY_SERVICE_TOKEN = "leak";
    try {
      const r = await shellTool(localWorkspace(root)).run(
        { command: 'echo "[$OPENAI_API_KEY$BOTT_FOO$MY_SERVICE_TOKEN]"' },
        ctx(),
      );
      expect(textOf(r.content).trim()).toBe("[]");
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.BOTT_FOO;
      delete process.env.MY_SERVICE_TOKEN;
    }
  });

  it("returns output and exit code from a real command", async () => {
    const ok = await shellTool(localWorkspace(root)).run({ command: "echo hi" }, ctx());
    expect(textOf(ok.content).trim()).toBe("hi");
    const bad = await shellTool(localWorkspace(root)).run(
      { command: "echo no >&2; exit 3" },
      ctx(),
    );
    expect(bad.isError).toBe(true);
    expect(textOf(bad.content)).toContain("Exit code: 3");
    expect(textOf(bad.content)).toContain("no");
  });
});
