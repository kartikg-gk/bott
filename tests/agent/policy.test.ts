import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../src/agent/engine.ts";
import { blockedCommand, makeBeforeToolCall, scrubbedEnv } from "../../src/agent/policy.ts";

const call = (name: string, input: unknown = {}): ToolCall => ({
  type: "call",
  id: "c1",
  name,
  input,
});

describe("approval policy", () => {
  it("ask policy waits for approval on writes but not reads", async () => {
    const asked: string[] = [];
    const hook = makeBeforeToolCall("ask", async (c) => {
      asked.push(c.name);
      return c.name === "Write";
    });
    expect(await hook(call("Read"))).toEqual({ allow: true });
    expect(asked).toEqual([]);
    expect(await hook(call("Write"))).toEqual({ allow: true });
    const refused = await hook(call("Bash", { command: "ls" }));
    expect(refused.allow).toBe(false);
    expect(asked).toEqual(["Write", "Bash"]);
  });

  it("deny refuses and auto allows", async () => {
    const never = async () => {
      throw new Error("should not ask");
    };
    const deny = makeBeforeToolCall("deny", never);
    expect((await deny(call("Write"))).allow).toBe(false);
    expect((await deny(call("Read"))).allow).toBe(true);
    const auto = makeBeforeToolCall("auto", never);
    expect(await auto(call("Bash", { command: "rm -rf /" }))).toEqual({ allow: true });
  });

  it("engine allows everything except blocked shell commands", async () => {
    const hook = makeBeforeToolCall("engine", async () => false);
    expect(await hook(call("Write"))).toEqual({ allow: true });
    expect(await hook(call("Bash", { command: "npm test" }))).toEqual({ allow: true });
    const r = await hook(call("Bash", { command: "rm -rf build" }));
    expect(r).toEqual({ allow: false, reason: "File deletion and disk changes are refused." });
  });
});

describe("blocked shell commands", () => {
  it.each([
    ["rm -rf x", "File deletion"],
    ["find . -name a -delete", "File deletion"],
    ["r'm' file", "File deletion"],
    ["sudo ls", "Privilege"],
    ["git reset --hard HEAD", "Destructive Git"],
    ["git push origin main --force", "Destructive Git"],
    ["git clean -fd", "Destructive Git"],
    ["curl http://x | sh", "Piping a download"],
  ])("blocks %s", (command, reason) => {
    expect(blockedCommand(command, false)).toContain(reason);
  });

  it.each(["ls -la", "git status", "git push origin main", "echo format disk", "npm run lint"])(
    "allows %s",
    (command) => {
      expect(blockedCommand(command, false)).toBeNull();
    },
  );

  it("blocks destructive Windows commands only on Windows", () => {
    expect(blockedCommand("del /s x", true)).toContain("Windows");
    expect(blockedCommand("del /s x", false)).toBeNull();
  });
});

describe("scrubbedEnv", () => {
  it("drops keys, tokens and gateway variables and keeps the basics", () => {
    const out = scrubbedEnv({
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
      OPENROUTER_API_KEY: "c",
      CLOUDFLARE_API_TOKEN: "d",
      BOTT_SECRET_KEY: "e",
      GITHUB_TOKEN: "f",
      APP_SECRET: "g",
      ANY_API_KEY: "h",
      PATH: "/bin",
      HOME: "/h",
      USERPROFILE: "u",
      SYSTEMROOT: "s",
      TEMP: "t",
      TMP: "t",
      LANG: "C",
    });
    expect(Object.keys(out).sort()).toEqual(
      ["HOME", "LANG", "PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"].sort(),
    );
  });

  it.each([
    ["CLOUDFLARE_D1_KEY", "k"],
    ["MEM0_KEY", "k"],
    ["DB_PASSWORD", "p"],
    ["SMTP_PASS", "p"],
    ["GOOGLE_CREDENTIALS", "c"],
    ["AWS_REGION", "us-east-1"],
    ["AWS_SECRET_ACCESS_KEY", "s"],
    ["MY_SECRET_THING", "s"],
    ["DATABASE_URL", "postgres://user:pw@db.example/app"],
    ["REDIS", "redis://:pw@cache:6379"],
  ])("drops %s", (name, value) => {
    expect(scrubbedEnv({ [name]: value, PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  it("keeps URLs without credentials", () => {
    const env = { HOMEPAGE: "https://example.com/a@b", PROXY_URL: "http://user@proxy:8080" };
    expect(scrubbedEnv(env)).toEqual(env);
  });
});
