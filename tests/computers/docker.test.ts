import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CliResult,
  CONTAINER_ROOT,
  type DockerCli,
  dockerComputer,
  MEMORY_MOUNT,
} from "../../src/computers/docker.ts";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "docker-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const ok = (stdout = ""): CliResult => ({
  code: 0,
  stdout: Buffer.from(stdout),
  stderr: "",
  timedOut: false,
});
const fail = (stderr = "", code = 1): CliResult => ({
  code,
  stdout: Buffer.alloc(0),
  stderr,
  timedOut: false,
});

/** A docker CLI that answers by the first argument and keeps every call. */
function fakeDocker(answers: Record<string, (args: string[]) => CliResult>) {
  const calls: string[][] = [];
  const cli: DockerCli = async (args) => {
    calls.push(args);
    const key = args[0] === "inspect" ? `inspect ${args[2]}` : (args[0] as string);
    return answers[key]?.(args) ?? ok();
  };
  return { cli, calls };
}

const RO_MOUNT = JSON.stringify([
  { Destination: CONTAINER_ROOT, RW: true },
  { Destination: MEMORY_MOUNT, RW: false },
]);

function computer(cli: DockerCli) {
  return dockerComputer({
    name: "bott-bot-main-abc",
    image: "debian:bookworm-slim",
    memory: "2g",
    hostRoot: join(base, "work"),
    memoryDir: join(base, "memory"),
    cli,
  });
}

const opts = () => ({ timeoutMs: 10_000, signal: new AbortController().signal, env: {} });

describe("docker computer", () => {
  it("creates a locked-down container on first use and runs commands in it", async () => {
    const { cli, calls } = fakeDocker({
      "inspect {{.State.Running}}": () => fail("Error: No such object"),
      exec: () => ok("hello\n"),
    });
    const ws = computer(cli);
    expect(ws.root).toBe(CONTAINER_ROOT);
    expect(ws.memoryPath).toBe(MEMORY_MOUNT);
    expect(calls).toEqual([]);

    const result = await ws.run("echo hello", opts());
    expect(result).toMatchObject({ code: 0, stdout: "hello\n", timedOut: false });

    const create = calls.find((c) => c[0] === "run") as string[];
    expect(create.slice(0, 4)).toEqual(["run", "-d", "--name", "bott-bot-main-abc"]);
    for (const flag of [
      ["--cap-drop", "ALL"],
      ["--security-opt", "no-new-privileges"],
      ["--pids-limit", "512"],
      ["--memory", "2g"],
      ["-w", CONTAINER_ROOT],
    ]) {
      expect(create.join(" ")).toContain(flag.join(" "));
    }
    expect(create).toContain(`type=bind,source=${join(base, "work")},target=${CONTAINER_ROOT}`);
    expect(create).toContain(
      `type=bind,source=${join(base, "memory")},target=${MEMORY_MOUNT},readonly`,
    );
    expect(create.slice(-3)).toEqual(["debian:bookworm-slim", "sleep", "infinity"]);

    const exec = calls.at(-1) as string[];
    expect(exec.slice(0, 4)).toEqual(["exec", "-w", CONTAINER_ROOT, "bott-bot-main-abc"]);
    expect(exec.at(-1)).toBe("timeout -s KILL 10 sh -c 'echo hello'");
  });

  it("starts the container once for many commands", async () => {
    const { cli, calls } = fakeDocker({
      "inspect {{.State.Running}}": () => fail("Error: No such object"),
    });
    const ws = computer(cli);
    await Promise.all([ws.run("a", opts()), ws.run("b", opts())]);
    expect(calls.filter((c) => c[0] === "run")).toHaveLength(1);
  });

  it("reuses a running container and starts a stopped one", async () => {
    const running = fakeDocker({
      "inspect {{.State.Running}}": () => ok("true\n"),
      "inspect {{json .Mounts}}": () => ok(RO_MOUNT),
    });
    await computer(running.cli).run("x", opts());
    expect(running.calls.map((c) => c[0])).toEqual(["inspect", "inspect", "exec"]);

    const stopped = fakeDocker({
      "inspect {{.State.Running}}": () => ok("false\n"),
      "inspect {{json .Mounts}}": () => ok(RO_MOUNT),
    });
    await computer(stopped.cli).run("x", opts());
    expect(stopped.calls.map((c) => c[0])).toEqual(["inspect", "inspect", "start", "exec"]);
  });

  it("refuses a container whose notes are writable", async () => {
    const { cli } = fakeDocker({
      "inspect {{.State.Running}}": () => ok("true\n"),
      "inspect {{json .Mounts}}": () =>
        ok(JSON.stringify([{ Destination: MEMORY_MOUNT, RW: true }])),
    });
    await expect(computer(cli).run("x", opts())).rejects.toThrow(
      "Container bott-bot-main-abc needs to be recreated with read-only bot note mounts",
    );
  });

  it("says when the container cannot start, and tries again next time", async () => {
    let attempts = 0;
    const { cli } = fakeDocker({
      "inspect {{.State.Running}}": () => fail("Error: No such object"),
      run: () => (++attempts === 1 ? fail("pull access denied") : ok("id")),
    });
    const ws = computer(cli);
    await expect(ws.run("x", opts())).rejects.toThrow(
      "The bot container did not start; look at Docker and the image",
    );
    await expect(ws.run("x", opts())).resolves.toMatchObject({ code: 0 });
  });

  it("reports a command that outlives its deadline", async () => {
    const { cli } = fakeDocker({
      "inspect {{.State.Running}}": () => fail("Error: No such object"),
      exec: () => ({ ...fail(), code: null, timedOut: true }),
    });
    const result = await computer(cli).run("sleep 100", opts());
    expect(result.timedOut).toBe(true);
  });

  it("stops keeping files and removes the container", async () => {
    const { cli, calls } = fakeDocker({
      "inspect {{.State.Running}}": () => fail("Error: No such object"),
      stop: () => fail("Error response from daemon: No such container: bott-bot-main-abc"),
      rm: () => fail("Error: No such container: bott-bot-main-abc"),
    });
    const ws = computer(cli);
    await ws.stop();
    expect(calls).toEqual([]);
    await ws.run("x", opts());
    await ws.stop();
    await ws.remove();
    expect(calls.filter((c) => c[0] === "stop")).toEqual([
      ["stop", "-t", "5", "bott-bot-main-abc"],
    ]);
    expect(calls.at(-1)).toEqual(["rm", "-f", "bott-bot-main-abc"]);
  });

  it("fails loudly when docker cannot remove the container", async () => {
    const { cli } = fakeDocker({ rm: () => fail("permission denied") });
    await expect(computer(cli).remove()).rejects.toThrow(
      "The bot container was not removed; look at Docker",
    );
  });
});
