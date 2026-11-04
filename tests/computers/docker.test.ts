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
import { SCRIPTS } from "../../src/computers/posix.ts";

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

function computer(cli: DockerCli, network: "open" | "closed" = "closed") {
  return dockerComputer({
    name: "bott-bot-main-abc",
    image: "debian:bookworm-slim",
    memory: "2g",
    hostRoot: join(base, "work"),
    memoryDir: join(base, "memory"),
    network,
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
      "inspect {{.HostConfig.NetworkMode}}": () => ok("none\n"),
    });
    await computer(running.cli).run("x", opts());
    expect(running.calls.map((c) => c[0])).toEqual(["inspect", "inspect", "inspect", "exec"]);

    const stopped = fakeDocker({
      "inspect {{.State.Running}}": () => ok("false\n"),
      "inspect {{json .Mounts}}": () => ok(RO_MOUNT),
      "inspect {{.HostConfig.NetworkMode}}": () => ok("none\n"),
    });
    await computer(stopped.cli).run("x", opts());
    expect(stopped.calls.map((c) => c[0])).toEqual([
      "inspect",
      "inspect",
      "inspect",
      "start",
      "exec",
    ]);
  });

  it("creates containers with the network open unless it is closed", async () => {
    for (const [network, flag] of [
      ["open", false],
      ["closed", true],
    ] as const) {
      const { cli, calls } = fakeDocker({
        "inspect {{.State.Running}}": () => fail("Error: No such object"),
      });
      await computer(cli, network).run("x", opts());
      const create = (calls.find((c) => c[0] === "run") as string[]).join(" ");
      expect(create.includes("--network none")).toBe(flag);
    }
  });

  it("refuses a container whose network does not match the setting", async () => {
    for (const [network, mode] of [
      ["closed", "bridge"],
      ["open", "none"],
    ] as const) {
      const { cli, calls } = fakeDocker({
        "inspect {{.State.Running}}": () => ok("true\n"),
        "inspect {{.HostConfig.NetworkMode}}": () => ok(`${mode}\n`),
        "inspect {{json .Mounts}}": () => ok(RO_MOUNT),
      });
      await expect(computer(cli, network).run("x", opts())).rejects.toThrow(
        `bott-bot-main-abc was made with its network ${mode === "none" ? "closed" : "open"}, but the setting is ${network}`,
      );
      expect(calls.some((c) => c[0] === "exec")).toBe(false);
    }
  });

  it("refuses a container whose notes are writable", async () => {
    const { cli } = fakeDocker({
      "inspect {{.HostConfig.NetworkMode}}": () => ok("none\n"),
      "inspect {{.State.Running}}": () => ok("true\n"),
      "inspect {{json .Mounts}}": () =>
        ok(JSON.stringify([{ Destination: MEMORY_MOUNT, RW: true }])),
    });
    await expect(computer(cli).run("x", opts())).rejects.toThrow(
      "bott-bot-main-abc can write to its notes; delete it so it is made again with /bot/memory read-only",
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
      "Docker could not run bott-bot-main-abc from debian:bookworm-slim",
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

  it("waits for a start under way before stopping", async () => {
    const order: string[] = [];
    let finishRun = () => {};
    const cli: DockerCli = async (args) => {
      order.push(args[0] as string);
      if (args[0] === "inspect") return fail("Error: No such object");
      if (args[0] === "run") {
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        });
        order.push("run done");
      }
      return ok();
    };
    const ws = computer(cli);
    const running = ws.run("x", opts());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopping = ws.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).not.toContain("stop");
    finishRun();
    await Promise.all([running, stopping]);
    expect(order.indexOf("stop")).toBeGreaterThan(order.indexOf("run done"));
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
      "Docker could not delete bott-bot-main-abc",
    );
  });
});

describe("docker files", () => {
  it("are written through the container's input and read from its output", async () => {
    const sent: { args: string[]; stdin?: Buffer }[] = [];
    const cli: DockerCli = async (args, o) => {
      sent.push({ args, stdin: o?.stdin });
      if (args[0] === "inspect") return fail("Error: No such object");
      if (args.includes(SCRIPTS.probe)) return ok("f\0");
      if (args.includes(SCRIPTS.cat)) return ok("stored");
      return ok();
    };
    const ws = computer(cli);
    await ws.writeFile(`${CONTAINER_ROOT}/a.txt`, "stored");
    const write = sent.find((s) => s.args.includes(SCRIPTS.put));
    expect(write?.args).toEqual([
      "exec",
      "-i",
      "bott-bot-main-abc",
      "sh",
      "-c",
      SCRIPTS.put,
      "sh",
      CONTAINER_ROOT,
      `${CONTAINER_ROOT}/a.txt`,
    ]);
    expect(write?.stdin?.toString()).toBe("stored");
    expect((await ws.readFile(`${CONTAINER_ROOT}/a.txt`)).toString()).toBe("stored");
  });
});
