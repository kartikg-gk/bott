import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MASTER_KEY_VARIABLE } from "../../src/accounts/sealing.ts";
import { ACCOUNTS_FILE, openAccountStore } from "../../src/accounts/store.ts";
import { ConstraintError } from "../../src/db/database.ts";
import { KEY } from "../support/accounts.ts";
import { FakeD1 } from "../support/fakeD1.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/sealed-accounts.sqlite3", import.meta.url));
const env = { [MASTER_KEY_VARIABLE]: KEY };

describe("opening the account store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const folder = () => {
    const dir = mkdtempSync(join(tmpdir(), "account-file-"));
    dirs.push(dir);
    return dir;
  };

  it("opens an existing account file in the state folder as it is", async () => {
    const stateDir = folder();
    copyFileSync(FIXTURE, join(stateDir, ACCOUNTS_FILE));
    const opened = await openAccountStore({ hosted: false, stateDir, realm: "realm-fixture", env });
    try {
      const [account] = await opened.store.allAccounts();
      expect(await opened.store.credential(String(account?.id), "model", "anthropic")).toBe(
        "sk-fixture-sealed-key",
      );
    } finally {
      await opened.close();
    }
  });

  it("makes a new account file only its owner can read, with foreign keys on", async () => {
    const stateDir = folder();
    const opened = await openAccountStore({ hosted: false, stateDir, realm: "r", env });
    try {
      if (process.platform !== "win32") {
        expect(statSync(join(stateDir, ACCOUNTS_FILE)).mode & 0o777).toBe(0o600);
      }
      await expect(opened.store.putCredential("nobody", "model", "openai", "k")).rejects.toThrow(
        ConstraintError,
      );
    } finally {
      await opened.close();
    }
  });

  it("refuses to open without a valid master key", async () => {
    await expect(
      openAccountStore({ hosted: false, stateDir: folder(), realm: "r", env: {} }),
    ).rejects.toThrow(`${MASTER_KEY_VARIABLE} must encode 32 random bytes as base64`);
  });

  it("opens on the gateway database when hosted, where earlier sealed rows still open", async () => {
    const fake = new FakeD1();
    const db = fake.database();
    const opened = await openAccountStore({
      hosted: true,
      db,
      stateDir: folder(),
      realm: "realm-fixture",
      env,
    });
    const old = new BetterSqlite3(FIXTURE, { readonly: true });
    for (const table of ["accounts", "credentials"]) {
      for (const row of old.prepare(`SELECT * FROM ${table}`).raw().all() as unknown[][]) {
        await db.run(
          `INSERT INTO ${table} VALUES(${row.map(() => "?").join(",")})`,
          row.map((value) => (Buffer.isBuffer(value) ? new Uint8Array(value) : value)) as never,
        );
      }
    }
    old.close();
    const [account] = await opened.store.allAccounts();
    expect(await opened.store.credential(String(account?.id), "model", "anthropic")).toBe(
      "sk-fixture-sealed-key",
    );
    // The gateway's database stays open for everything else using it.
    await opened.close();
    expect(await db.query("SELECT count(*) AS n FROM accounts")).toEqual([{ n: 1 }]);
    await db.close();
  });

  it("needs the gateway database when hosted", async () => {
    await expect(
      openAccountStore({ hosted: true, stateDir: folder(), realm: "r", env }),
    ).rejects.toThrow("Hosted accounts need the gateway database");
  });
});
