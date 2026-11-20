import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { ensureSchema } from "../src/db/schema.ts";
import { SCHEMA_MARK } from "../src/db/status.ts";
import type { Probe, ProbeResult } from "../src/doctor.ts";
import { readSettings } from "../src/doctor.ts";
import { KEY } from "./support/accounts.ts";
import { database } from "./support/fakeD1.ts";

const TOKEN = "a-token-long-enough-for-tests";
const INSTANCE = "ab".repeat(16);
const D1 = {
  CLOUDFLARE_API_TOKEN: "token-1",
  CLOUDFLARE_ACCOUNT_ID: "account-1",
  CLOUDFLARE_D1_DATABASE_ID: "database-1",
};

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const found = (stdout = ""): ProbeResult => ({ missing: false, status: 0, stdout });
const absent: ProbeResult = { missing: true, status: null, stdout: "" };

/** Every program is installed unless named otherwise. */
function programs(answers: Record<string, ProbeResult> = {}): Probe {
  return (command, args) => answers[`${command} ${args[0]}`] ?? answers[command] ?? found();
}

/** Runs the doctor against a schema-ready fake D1, so nothing leaves the test. */
async function check(env: Record<string, string>, probe: Probe = programs()) {
  const lines: string[] = [];
  const opened = database("d1");
  await ensureSchema(opened.db);
  // The doctor closes what it opens; this covers runs that never open it.
  cleanups.push(() => opened.db.close().catch(() => {}));
  const code = await main(["doctor"], {
    env,
    cwd: folder(),
    out: (line) => lines.push(line),
    probe,
    database: () => opened.db,
  });
  const fixes = lines.filter((line) => line.startsWith("fix "));
  const notes = lines.filter((line) => line.startsWith("note "));
  return { code, lines, fixes, notes, text: lines.join("\n") };
}

const tokenReady = () => ({
  BOTT_STATE_DIR: folder(),
  BOTT_INSTANCE: INSTANCE,
  BOTT_WEB_TOKEN: TOKEN,
  BOTT_PROVIDER: "anthropic",
  BOTT_MODEL: "m",
  ANTHROPIC_API_KEY: "sk-test",
  ...D1,
});

const googleReady = () => ({
  BOTT_HOSTED: "1",
  BOTT_INSTANCE: INSTANCE,
  BOTT_MASTER_KEY: KEY,
  BOTT_ORIGIN: "https://bott.example.test",
  BOTT_GOOGLE_CLIENT_ID: "client",
  BOTT_GOOGLE_CLIENT_SECRET: "secret",
  BOTT_ALLOWED_DOMAINS: "example.test",
  ...D1,
});

describe("bott doctor", () => {
  it("passes a complete setup, with a line for each part", async () => {
    const run = await check(tokenReady());
    expect(run.fixes).toEqual([]);
    expect(run.code).toBe(0);
    expect(run.text).toContain(`D1: answers, schema ${SCHEMA_MARK}`);
    expect(run.text).toContain("ok    Model anthropic/m");
    for (const tool of ["pdftotext", "pdftoppm", "tesseract"]) {
      expect(run.text).toContain(`ok    ${tool} is installed`);
    }
    expect(run.lines.at(-1)).toBe("Everything needed is in place.");
  });

  it("lists every unreadable setting at once instead of the first", async () => {
    const run = await check({
      ...tokenReady(),
      BOTT_PORT: "nope",
      BOTT_INSTANCE: "not-hex",
      BOTT_POLICY: "maybe",
    });
    expect(run.code).toBe(1);
    expect(run.fixes.join("\n")).toMatch(/BOTT_PORT/);
    expect(run.fixes.join("\n")).toMatch(/BOTT_INSTANCE must be 32 hex/);
    expect(run.fixes.join("\n")).toMatch(/BOTT_POLICY/);
  });

  it("stops when a setting it needs is missing rather than wrong", () => {
    const { config, problems } = readSettings({ BOTT_HOSTED: "1" });
    expect(config).toBeNull();
    expect(problems).toEqual([expect.stringMatching(/Set BOTT_INSTANCE/)]);
  });

  it("names the missing parts of D1 without trying to reach it", async () => {
    const { CLOUDFLARE_ACCOUNT_ID: _a, CLOUDFLARE_API_TOKEN: _t, ...partial } = tokenReady();
    const run = await check(partial);
    expect(run.fixes).toContainEqual(
      expect.stringMatching(/CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID/),
    );
    expect(run.text).not.toMatch(/answers, schema/);
  });

  it("asks for a fixed instance when this machine shares D1 with a hosted one", async () => {
    const { BOTT_INSTANCE: _i, ...env } = tokenReady();
    const run = await check(env);
    expect(run.fixes).toContainEqual(expect.stringMatching(/Set BOTT_INSTANCE/));
  });

  it("checks the key for the chosen model provider", async () => {
    const { ANTHROPIC_API_KEY: _k, ...env } = tokenReady();
    const run = await check(env);
    expect(run.fixes).toEqual([expect.stringMatching(/Set ANTHROPIC_API_KEY/)]);
  });

  it("refuses a malformed master key in either sign-in mode", async () => {
    const token = await check({ ...tokenReady(), BOTT_MASTER_KEY: "short" });
    expect(token.fixes).toEqual([expect.stringMatching(/BOTT_MASTER_KEY/)]);
    const google = await check({ ...googleReady(), BOTT_MASTER_KEY: "short" });
    expect(google.fixes).toEqual([expect.stringMatching(/BOTT_MASTER_KEY/)]);
  });

  it("passes a complete hosted setup", async () => {
    const run = await check(googleReady());
    expect(run.fixes).toEqual([]);
    expect(run.text).toContain("ok    Origin https://bott.example.test");
    expect(run.text).toContain("ok    Google client is set");
  });

  it("checks each part of Google sign-in", async () => {
    const {
      BOTT_GOOGLE_CLIENT_SECRET: _s,
      BOTT_ALLOWED_DOMAINS: _d,
      BOTT_ORIGIN: _o,
      ...env
    } = googleReady();
    const run = await check(env);
    expect(run.fixes).toEqual([
      expect.stringMatching(/BOTT_ORIGIN/),
      expect.stringMatching(/BOTT_GOOGLE_CLIENT_SECRET/),
      expect.stringMatching(/BOTT_ALLOWED_EMAILS or BOTT_ALLOWED_DOMAINS/),
    ]);
  });

  it("will not serve Google sign-in over plain HTTP on an open address", async () => {
    const { BOTT_HOSTED: _h, ...hosted } = googleReady();
    const env = {
      ...hosted,
      BOTT_AUTH: "google",
      BOTT_ORIGIN: "http://localhost:8765",
      BOTT_HOST: "0.0.0.0",
    };
    const run = await check(env);
    expect(run.fixes).toEqual([expect.stringMatching(/plain HTTP.*loopback/)]);
    // A refused origin is reported once, not again as missing.
    const other = await check({ ...env, BOTT_ORIGIN: "http://bott.example.test" });
    expect(other.fixes).toEqual([expect.stringMatching(/BOTT_ORIGIN: .*HTTPS/)]);
  });

  it("finds hosted mode without D1", async () => {
    const { CLOUDFLARE_D1_DATABASE_ID: _a, CLOUDFLARE_ACCOUNT_ID: _b, ...rest } = googleReady();
    const { CLOUDFLARE_API_TOKEN: _c, ...env } = rest;
    const run = await check(env);
    expect(run.fixes).toEqual([expect.stringMatching(/Hosted mode keeps its data in D1/)]);
  });

  it("finds half an app client and a weak proxy secret", async () => {
    const run = await check({
      ...tokenReady(),
      BOTT_GITHUB_CLIENT_ID: "id",
      BOTT_NOTION_CLIENT_ID: "id",
      BOTT_NOTION_CLIENT_SECRET: "secret",
      BOTT_PROXY_SECRET: "short",
    });
    expect(run.fixes).toEqual([
      expect.stringMatching(/BOTT_PROXY_SECRET must be 43/),
      expect.stringMatching(/Set BOTT_GITHUB_CLIENT_SECRET to go with BOTT_GITHUB_CLIENT_ID/),
    ]);
    expect(run.text).toContain("ok    App clients for notion");
  });

  it("checks Docker and its image for the docker executor", async () => {
    const env = { ...tokenReady(), BOTT_EXECUTOR: "docker" };
    const ready = await check(env, programs({ "docker version": found("29.0.1\n") }));
    expect(ready.text).toContain("ok    Docker 29.0.1 answers");
    expect(ready.text).toContain("ok    Image debian:bookworm-slim is here");
    const unpulled = await check(
      env,
      programs({ "docker image": { missing: false, status: 1, stdout: "" } }),
    );
    expect(unpulled.code).toBe(0);
    expect(unpulled.notes).toContainEqual(expect.stringMatching(/not pulled yet/));
    const down = await check(env, programs({ docker: { missing: false, status: 1, stdout: "" } }));
    expect(down.fixes).toEqual([expect.stringMatching(/Docker does not answer/)]);
  });

  it("checks the Daytona key and where the network setting applies", async () => {
    const daytona = await check({ ...tokenReady(), BOTT_EXECUTOR: "daytona" });
    expect(daytona.fixes).toEqual([expect.stringMatching(/DAYTONA_API_KEY/)]);
    const local = await check({ ...tokenReady(), BOTT_SANDBOX_NETWORK: "closed" });
    expect(local.code).toBe(0);
    expect(local.notes).toContainEqual(expect.stringMatching(/BOTT_SANDBOX_NETWORK has no effect/));
  });

  it("only notes document programs that are not installed", async () => {
    const run = await check(tokenReady(), programs({ pdftotext: absent, tesseract: absent }));
    expect(run.code).toBe(0);
    expect(run.notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/pdftotext is not installed/),
        expect.stringMatching(/tesseract is not installed/),
      ]),
    );
    expect(run.text).toContain("ok    pdftoppm is installed");
  });

  it("asks for an embeddings service when memory is on", async () => {
    const run = await check({ ...tokenReady(), BOTT_MEMORY: "on" });
    expect(run.fixes).toEqual([expect.stringMatching(/OPENAI_API_KEY/)]);
  });
});
