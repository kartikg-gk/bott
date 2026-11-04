import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../../src/db/schemaSql.js";

describe("schema text", () => {
  it("ships inside the module, so a bundle needs no file beside it", () => {
    expect(SCHEMA_SQL).toContain("CREATE TABLE web_runs(");
    expect(SCHEMA_SQL).toContain("CREATE TRIGGER cancel_queued_wakeups");
    expect(existsSync(new URL("../../src/db/schema.sql", import.meta.url))).toBe(false);
    const loader = readFileSync(new URL("../../src/db/schema.ts", import.meta.url), "utf8");
    expect(loader).not.toMatch(/readFileSync|node:fs/);
  });
});
