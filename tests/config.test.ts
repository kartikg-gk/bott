import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, readConfig, SETTINGS } from "../src/config.ts";

const HOME = resolve("/home/someone");

describe("reading the settings from the environment", () => {
  it("runs on this machine with a token by default", () => {
    const config = readConfig({}, { home: HOME });
    expect(config.hosted).toBe(false);
    expect(config.auth).toBe("token");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8765);
    expect(config.stateDir).toBe(join(HOME, ".bott"));
    expect(config.projectDir).toBe(join(HOME, ".bott", "workspace"));
    expect(config.databasePath).toBe(join(HOME, ".bott", "gateway.sqlite3"));
    expect(config.instance).toMatch(/^[0-9a-f]{32}$/);
    expect(config.policy).toBe("ask");
    expect(config.idleSeconds).toBe(1800);
    expect(config.approvalSeconds).toBe(300);
    expect(config.computer.executor).toBe("local");
    expect(config.limits.requestsPerRun).toBe(100);
    expect(config.memory.enabled).toBe(false);
  });

  it("keeps one instance for one state folder and another for the next", () => {
    const first = readConfig({ BOTT_STATE_DIR: "/srv/a" }, { home: HOME });
    expect(readConfig({ BOTT_STATE_DIR: "/srv/a" }, { home: HOME }).instance).toBe(first.instance);
    expect(readConfig({ BOTT_STATE_DIR: "/srv/b" }, { home: HOME }).instance).not.toBe(
      first.instance,
    );
    const named = readConfig({ BOTT_INSTANCE: "AB".repeat(16) }, { home: HOME });
    expect(named.instance).toBe("ab".repeat(16));
  });

  it("reads each setting it names", () => {
    const config = readConfig(
      {
        BOTT_HOST: "0.0.0.0",
        BOTT_PORT: "9000",
        BOTT_STATE_DIR: "/srv/bott",
        BOTT_PROJECT_DIR: "/srv/code",
        BOTT_DATABASE: "/srv/db/main.sqlite3",
        BOTT_ACTOR: "42",
        BOTT_AUTH: "google",
        BOTT_ORIGIN: "https://bott.example.test/",
        BOTT_ALLOWED_EMAILS: "a@example.test, B@example.test",
        BOTT_ALLOWED_DOMAINS: "example.test",
        BOTT_PROVIDER: "anthropic",
        BOTT_MODEL: "claude-opus-5-5",
        BOTT_POLICY: "auto",
        BOTT_IDLE_SECONDS: "60",
        BOTT_APPROVAL_SECONDS: "120",
        BOTT_WORKERS: "4",
        BOTT_EXECUTOR: "docker",
        BOTT_DOCKER_IMAGE: "busybox:1.36",
        BOTT_SANDBOX_NETWORK: "closed",
        BOTT_REQUESTS_PER_DAY: "50",
        BOTT_SPEND_MICROS_PER_RUN: "2000000",
        BOTT_ATTEMPT_MAX_MICROS: '{"anthropic/claude-opus-5-5": 500000}',
        BOTT_MEMORY: "on",
        BOTT_MEMORY_EXTRACT: "on",
        BOTT_QDRANT_URL: "http://localhost:6333",
      },
      { home: HOME },
    );
    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
      stateDir: resolve("/srv/bott"),
      projectDir: resolve("/srv/code"),
      databasePath: resolve("/srv/db/main.sqlite3"),
      actor: 42,
      auth: "google",
      origin: "https://bott.example.test",
      allowedEmails: ["a@example.test", "B@example.test"],
      allowedDomains: ["example.test"],
      provider: "anthropic",
      model: "claude-opus-5-5",
      policy: "auto",
      idleSeconds: 60,
      approvalSeconds: 120,
      workers: 4,
    });
    expect(config.computer).toMatchObject({
      executor: "docker",
      dockerImage: "busybox:1.36",
      sandboxNetwork: "closed",
    });
    expect(config.limits).toMatchObject({
      requestsPerDay: 50,
      spendMicrosPerRun: 2_000_000,
      attemptMaxMicros: { "anthropic/claude-opus-5-5": 500_000 },
    });
    expect(config.memory).toMatchObject({
      enabled: true,
      extract: true,
      qdrantUrl: "http://localhost:6333",
    });
  });

  it("signs people in with Google when hosted and keeps state in a scratch folder", () => {
    const config = readConfig(
      { BOTT_HOSTED: "1", BOTT_INSTANCE: "c".repeat(32) },
      { home: HOME, scratch: "/tmp" },
    );
    expect(config.hosted).toBe(true);
    expect(config.auth).toBe("google");
    expect(config.stateDir).toBe(join(resolve("/tmp"), "bott"));
    expect(readConfig({ VERCEL: "1", BOTT_INSTANCE: "c".repeat(32) }).hosted).toBe(true);
  });

  it("refuses what cannot work, naming the setting", () => {
    const bad: [Record<string, string>, RegExp][] = [
      [{ BOTT_PORT: "70000" }, /BOTT_PORT/],
      [{ BOTT_PORT: "80a" }, /BOTT_PORT/],
      [{ BOTT_POLICY: "maybe" }, /BOTT_POLICY/],
      [{ BOTT_AUTH: "password" }, /BOTT_AUTH/],
      [{ BOTT_INSTANCE: "not-hex" }, /BOTT_INSTANCE/],
      [{ BOTT_PROVIDER: "elsewhere" }, /BOTT_PROVIDER/],
      [{ BOTT_EXECUTOR: "vm" }, /BOTT_EXECUTOR/],
      [{ BOTT_MEMORY: "perhaps" }, /BOTT_MEMORY/],
      [{ BOTT_ATTEMPT_MAX_MICROS: "[1]" }, /BOTT_ATTEMPT_MAX_MICROS/],
      [{ BOTT_HOSTED: "1" }, /BOTT_INSTANCE/],
      [{ BOTT_HOSTED: "1", BOTT_INSTANCE: "c".repeat(32), BOTT_AUTH: "token" }, /Google/],
      [{ BOTT_HOSTED: "1", BOTT_INSTANCE: "c".repeat(32), BOTT_MEMORY: "on" }, /memory/],
    ];
    for (const [env, message] of bad) {
      expect(() => readConfig(env, { home: HOME })).toThrow(ConfigError);
      expect(() => readConfig(env, { home: HOME })).toThrow(message);
    }
  });

  it("lists every setting it reads", () => {
    const names = SETTINGS.map((setting) => setting.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^(BOTT_[A-Z0-9_]+|[A-Z0-9_]+)$/);
    expect(names).toContain("BOTT_WEB_TOKEN");
    expect(names).toContain("BOTT_MASTER_KEY");
    expect(names).toContain("CLOUDFLARE_D1_DATABASE_ID");
  });
});
