import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY } from "./support/accounts.ts";
import { ACCOUNT, DATABASE_ID, FakeD1, TOKEN } from "./support/fakeD1.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** Every source file a module reaches through its relative imports. */
function reached(path: string, seen = new Set<string>()): Set<string> {
  // Sources import each other as .ts or as the .js they compile to.
  const entry = existsSync(path) ? path : path.replace(/\.js$/, ".ts");
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const text = readFileSync(entry, "utf8");
  for (const match of text.matchAll(/(?:import|export)[^"']*?from\s+["'](\.[^"']+)["']/g)) {
    reached(resolve(dirname(entry), match[1] as string), seen);
  }
  for (const match of text.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    reached(resolve(dirname(entry), match[1] as string), seen);
  }
  return seen;
}

describe("the hosted function", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("is deployed as one long-lived function with every path sent to it", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
    expect(config.fluid).toBe(true);
    expect(config.functions["api/index.js"].maxDuration).toBe(300);
    expect(config.rewrites).toEqual([{ source: "/(.*)", destination: "/api/index" }]);
    const entry = readFileSync(join(ROOT, "api", "index.js"), "utf8");
    expect(entry).toContain("../dist/src/vercel.js");
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(entry).toContain(method);
    }
  });

  it("leaves the runner and the command line out of the function", () => {
    const files = [...reached(join(ROOT, "src", "vercel.ts"))].map((file) =>
      file.slice(ROOT.length + 1).replaceAll("\\", "/"),
    );
    expect(files).toContain("src/startup.ts");
    expect(files).toContain("src/db/schemaSql.ts");
    expect(files).not.toContain("src/runner.ts");
    expect(files).not.toContain("src/cli.ts");
    expect(files.filter((file) => file.endsWith(".sql"))).toEqual([]);
  });

  it("answers requests from the settings in its environment, on D1", async () => {
    const fake = new FakeD1();
    vi.stubGlobal("fetch", fake.fetch);
    const env: Record<string, string> = {
      VERCEL: "1",
      BOTT_INSTANCE: "ab".repeat(16),
      BOTT_ORIGIN: "https://bott.example.test",
      BOTT_MASTER_KEY: KEY,
      BOTT_GOOGLE_CLIENT_ID: "client",
      BOTT_GOOGLE_CLIENT_SECRET: "secret",
      BOTT_ALLOWED_EMAILS: "alice@example.test",
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_D1_DATABASE_ID: DATABASE_ID,
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const { GET } = await import("../src/vercel.ts");
    const response = await GET(
      new Request("https://bott.example.test/auth/session", {
        headers: { host: "bott.example.test" },
      }),
    );
    expect(await response.json()).toEqual({ mode: "google", email: null });
    const tables = fake.connection
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('bots','accounts')")
      .all();
    expect(tables).toHaveLength(2);
  });

  it("says it is not set up, without details, when its settings are wrong", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("BOTT_INSTANCE", "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("../src/vercel.ts");
    const response = await GET(new Request("https://bott.example.test/"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "This server is not set up correctly" });
    expect(String(errors.mock.calls[0]?.[0])).toMatch(/BOTT_INSTANCE/);
    errors.mockRestore();
  });
});
