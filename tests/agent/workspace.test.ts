import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localWorkspace } from "../../src/agent/tools/workspace.ts";

let base: string;
let root: string;
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "local-"));
  root = path.join(base, "work");
  mkdirSync(root);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("files on this machine", () => {
  it("resolve inside the workspace only", async () => {
    const ws = localWorkspace(root);
    expect(await ws.realpath("a/b.txt")).toBe(path.join(root, "a", "b.txt"));
    expect(await ws.realpath("../other")).toBeNull();
  });

  it("write with parents, read, stat and list", async () => {
    const ws = localWorkspace(root);
    await ws.writeFile(path.join(root, "a", "b.txt"), "hello");
    expect(readFileSync(path.join(root, "a", "b.txt"), "utf8")).toBe("hello");
    expect((await ws.readFile(path.join(root, "a", "b.txt"))).toString()).toBe("hello");
    writeFileSync(path.join(root, "c.txt"), "");

    expect(await ws.stat(path.join(root, "a", "b.txt"))).toMatchObject({ kind: "file", size: 5 });
    expect(await ws.stat(path.join(root, "a"))).toMatchObject({ kind: "directory" });
    expect(await ws.stat(path.join(root, "missing"))).toBeNull();
    expect(await ws.list(root)).toEqual([
      { name: "a", kind: "directory" },
      { name: "c.txt", kind: "file" },
    ]);
  });
});
