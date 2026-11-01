import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunOptions, Workspace } from "../../src/agent/tools/workspace.ts";
import { dockerComputer } from "../../src/computers/docker.ts";

const IMAGE = "debian:bookworm-slim";

/** Real containers need a running Docker and the test image already pulled. */
function dockerReady(): boolean {
  try {
    const found = spawnSync("docker", ["image", "inspect", IMAGE], {
      stdio: "ignore",
      timeout: 20_000,
    });
    return found.status === 0;
  } catch {
    return false;
  }
}

const ready = dockerReady();
const opts = (seconds = 30): RunOptions => ({
  timeoutMs: seconds * 1000,
  signal: new AbortController().signal,
  env: {},
});

describe.skipIf(!ready)("a real docker computer", () => {
  const name = `bott-test-${randomUUID().slice(0, 8)}`;
  let base: string;
  let ws: Workspace;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "docker-live-"));
    mkdirSync(join(base, "memory"));
    writeFileSync(join(base, "memory", "KNOWLEDGE.md"), "# Knowledge\nfact\n");
    ws = dockerComputer({
      name,
      image: IMAGE,
      memory: "512m",
      hostRoot: join(base, "work"),
      memoryDir: join(base, "memory"),
    });
  });
  afterAll(() => {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    rmSync(base, { recursive: true, force: true });
  });

  it("runs commands in the workspace and keeps files on the mounted folder", async () => {
    const made = await ws.run("pwd && echo hi > note.txt && echo oops >&2", opts());
    expect(made.code).toBe(0);
    expect(made.stdout.trim()).toBe("/workspace");
    expect(made.stderr.trim()).toBe("oops");
    expect(readFileSync(join(base, "work", "note.txt"), "utf8")).toBe("hi\n");
  }, 120_000);

  it("drops every capability and sees the notes read-only", async () => {
    const caps = await ws.run("grep CapEff /proc/self/status", opts());
    expect(caps.stdout).toMatch(/CapEff:\s+0+\s*$/);
    const notes = await ws.run("cat /bot/memory/KNOWLEDGE.md", opts());
    expect(notes.stdout).toContain("fact");
    const write = await ws.run("echo x > /bot/memory/KNOWLEDGE.md", opts());
    expect(write.code).not.toBe(0);
    expect(readFileSync(join(base, "memory", "KNOWLEDGE.md"), "utf8")).toContain("fact");
  }, 60_000);

  it("kills a command at its deadline", async () => {
    const slow = await ws.run("sleep 30", opts(1));
    expect(slow.timedOut).toBe(true);
  }, 60_000);

  it("keeps installed files across a stop and removes everything on remove", async () => {
    await ws.run("echo kept > /tmp/inside.txt", opts());
    await ws.stop();
    const after = await ws.run("cat /tmp/inside.txt", opts());
    expect(after.stdout.trim()).toBe("kept");

    await ws.remove();
    const gone = spawnSync("docker", ["inspect", name], { stdio: "ignore" });
    expect(gone.status).not.toBe(0);
    expect(existsSync(join(base, "work", "note.txt"))).toBe(true);
  }, 120_000);
});
