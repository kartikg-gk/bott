import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { Database, Param, Row } from "../db/database.ts";
import { SqliteDatabase } from "../db/sqlite.ts";
import { associatedData, MASTER_KEY_VARIABLE, masterKey, Sealer } from "./sealing.ts";

export const SESSION_SECONDS = 12 * 60 * 60;
export const FLOW_SECONDS = 600;
export const VALIDATION_SECONDS = 300;
export const VALIDATION_LIMIT = 5;
/** Pending sign-ins kept at once; more are refused until some finish or expire. */
const FLOW_CAP = 1024;

/**
 * The account tables. They live outside the main schema because they may sit in their own file; the
 * columns match what is already stored so existing account files and databases open as they are.
 */
const TABLES = [
  "CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, subject TEXT NOT NULL UNIQUE, " +
    "email TEXT NOT NULL, domain TEXT, provider TEXT, model TEXT)",
  "CREATE TABLE IF NOT EXISTS flows(state BLOB PRIMARY KEY, browser BLOB NOT NULL, " +
    "verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS app_flows(account TEXT NOT NULL REFERENCES accounts(id), " +
    "app TEXT NOT NULL, session BLOB NOT NULL, state BLOB NOT NULL, verifier TEXT NOT NULL, " +
    "expires REAL NOT NULL, PRIMARY KEY(account,app,session))",
  "CREATE TABLE IF NOT EXISTS sessions(token BLOB PRIMARY KEY, " +
    "account TEXT NOT NULL REFERENCES accounts(id), expires REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS credentials(account TEXT NOT NULL REFERENCES accounts(id), " +
    "kind TEXT NOT NULL, name TEXT NOT NULL, sealed BLOB NOT NULL, " +
    "PRIMARY KEY(account,kind,name))",
  "CREATE TABLE IF NOT EXISTS attempts(account TEXT NOT NULL REFERENCES accounts(id), " +
    "attempted REAL NOT NULL)",
  "CREATE INDEX IF NOT EXISTS attempts_account ON attempts(account,attempted)",
];

export interface Account {
  id: string;
  subject: string;
  email: string;
  domain: string | null;
  provider: string | null;
  model: string | null;
}

export interface AccountStoreOptions {
  /** Seconds since the epoch. */
  clock?: () => number;
}

/** SHA-256 of a secret, which is all that is kept of tokens and flow states. */
export function digest(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value, "utf8").digest());
}

/** A random 32-byte token in URL-safe base64, 43 characters long. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function toAccount(row: Row): Account {
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  return {
    id: String(row.id),
    subject: String(row.subject),
    email: String(row.email),
    domain: text(row.domain),
    provider: text(row.provider),
    model: text(row.model),
  };
}

/** People who signed in, their sessions, and the credentials sealed for each of them. */
export class AccountStore {
  private constructor(
    readonly db: Database,
    readonly realm: string,
    private readonly sealer: Sealer,
    private readonly clock: () => number,
  ) {}

  /** Opens the account tables on any database, creating them when missing. */
  static async open(
    db: Database,
    realm: string,
    encodedKey: string,
    opts: AccountStoreOptions = {},
  ): Promise<AccountStore> {
    const sealer = new Sealer(masterKey({ [MASTER_KEY_VARIABLE]: encodedKey }));
    for (const statement of TABLES) await db.run(statement);
    return new AccountStore(db, realm, sealer, opts.clock ?? (() => Date.now() / 1000));
  }

  private async one(sql: string, params: Param[]): Promise<Row | null> {
    return (await this.db.query(sql, params))[0] ?? null;
  }

  /** Records a pending sign-in for one browser, replacing that browser's earlier one. */
  async startFlow(state: string, browser: string, verifier: string, nonce: string): Promise<void> {
    const now = this.clock();
    await this.db.run("DELETE FROM flows WHERE expires<=? OR browser=?", [now, digest(browser)]);
    // Counting and inserting in one statement keeps the cap under concurrent sign-ins.
    const added = await this.db.run(
      "INSERT INTO flows SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM flows) < CAST(? AS INTEGER)",
      [digest(state), digest(browser), verifier, nonce, now + FLOW_SECONDS, FLOW_CAP],
    );
    if (!added) throw new Error("Sign-in is handling other requests; retry in a moment.");
  }

  /** Takes the pending sign-in for this state and browser, at most once. */
  async consumeFlow(
    state: string,
    browser: string,
  ): Promise<{ verifier: string; nonce: string } | null> {
    const row = await this.one(
      "DELETE FROM flows WHERE state=? AND browser=? AND expires>? RETURNING verifier,nonce",
      [digest(state), digest(browser), this.clock()],
    );
    return row ? { verifier: String(row.verifier), nonce: String(row.nonce) } : null;
  }

  /** Creates or updates the account for this identity and returns a new session token. */
  async signIn(subject: string, email: string, domain: string | null): Promise<string> {
    const token = newToken();
    const now = this.clock();
    await this.db.run("DELETE FROM sessions WHERE expires<=?", [now]);
    const row = await this.one(
      "INSERT INTO accounts(id,subject,email,domain) VALUES(?,?,?,?) " +
        "ON CONFLICT(subject) DO UPDATE SET email=excluded.email,domain=excluded.domain " +
        "RETURNING id",
      [randomUUID().replaceAll("-", ""), subject, email, domain],
    );
    await this.db.run("INSERT INTO sessions VALUES(?,?,?)", [
      digest(token),
      String(row?.id),
      now + SESSION_SECONDS,
    ]);
    return token;
  }

  /** The account a live session token belongs to. */
  async session(token: string | null | undefined): Promise<Account | null> {
    if (token?.length !== 43) return null;
    const row = await this.one(
      "SELECT a.* FROM accounts a JOIN sessions s ON s.account=a.id " +
        "WHERE s.token=? AND s.expires>?",
      [digest(token), this.clock()],
    );
    return row ? toAccount(row) : null;
  }

  async signOut(token: string | null | undefined): Promise<void> {
    if (token) await this.db.run("DELETE FROM sessions WHERE token=?", [digest(token)]);
  }

  async account(id: string): Promise<Account | null> {
    const row = await this.one("SELECT * FROM accounts WHERE id=?", [id]);
    return row ? toAccount(row) : null;
  }

  async allAccounts(): Promise<Account[]> {
    return (await this.db.query("SELECT * FROM accounts")).map(toAccount);
  }

  /** Records a pending app connection for one signed-in session. */
  async startAppFlow(
    account: string,
    app: string,
    session: string,
    state: string,
    verifier: string,
  ): Promise<void> {
    const now = this.clock();
    await this.db.run("DELETE FROM app_flows WHERE expires<=?", [now]);
    await this.db.run("INSERT OR REPLACE INTO app_flows VALUES(?,?,?,?,?,?)", [
      account,
      app,
      digest(session),
      digest(state),
      verifier,
      now + FLOW_SECONDS,
    ]);
  }

  /** Takes the pending app connection's verifier, at most once. */
  async consumeAppFlow(
    account: string,
    app: string,
    session: string,
    state: string,
  ): Promise<string | null> {
    const row = await this.one(
      "DELETE FROM app_flows WHERE account=? AND app=? AND session=? AND state=? " +
        "AND expires>? RETURNING verifier",
      [account, app, digest(session), digest(state), this.clock()],
    );
    return row ? String(row.verifier) : null;
  }

  async deleteCredential(account: string, kind: string, name: string): Promise<void> {
    await this.db.run("DELETE FROM credentials WHERE account=? AND kind=? AND name=?", [
      account,
      kind,
      name,
    ]);
  }

  async deleteAppToken(account: string, app: string): Promise<void> {
    await this.deleteCredential(account, "app", app);
  }

  /** Forgets an app's token and any connection still pending for it. */
  async removeApp(account: string, app: string): Promise<void> {
    await this.deleteAppToken(account, app);
    await this.db.run("DELETE FROM app_flows WHERE account=? AND app=?", [account, app]);
  }

  private bound(account: string, kind: string, name: string): Buffer {
    return associatedData(this.realm, account, kind, name);
  }

  /** The opened credential, or null when none is saved. Throws SealError if it will not open. */
  async credential(account: string, kind: string, name: string): Promise<string | null> {
    const row = await this.one(
      "SELECT sealed FROM credentials WHERE account=? AND kind=? AND name=?",
      [account, kind, name],
    );
    if (!row) return null;
    return this.sealer.open(row.sealed as Uint8Array, this.bound(account, kind, name));
  }

  async names(account: string, kind: string): Promise<string[]> {
    const rows = await this.db.query(
      "SELECT name FROM credentials WHERE account=? AND kind=? ORDER BY name",
      [account, kind],
    );
    return rows.map((row) => String(row.name));
  }

  async putCredential(account: string, kind: string, name: string, value: string): Promise<void> {
    const sealed = this.sealer.seal(value, this.bound(account, kind, name));
    await this.db.run("INSERT OR REPLACE INTO credentials VALUES(?,?,?,?)", [
      account,
      kind,
      name,
      sealed,
    ]);
  }

  /** Selects the account's provider and model, saving a new key for it when one is given. */
  async setModel(account: string, provider: string, model: string, key?: string): Promise<void> {
    if (key !== undefined) await this.putCredential(account, "model", provider, key);
    await this.db.run("UPDATE accounts SET provider=?,model=? WHERE id=?", [
      provider,
      model,
      account,
    ]);
  }

  /** Deletes a provider's key and clears the selection if it pointed at that provider. */
  async removeModelKey(account: string, provider: string): Promise<void> {
    await this.deleteCredential(account, "model", provider);
    await this.db.run("UPDATE accounts SET provider=NULL,model=NULL WHERE id=? AND provider=?", [
      account,
      provider,
    ]);
  }

  /** Counts one key check against the account's limit; false when the limit is reached. */
  async validationAttempt(account: string, now = this.clock()): Promise<boolean> {
    await this.db.run("DELETE FROM attempts WHERE attempted<=?", [now - VALIDATION_SECONDS]);
    // Counting and inserting in one statement keeps parallel checks under the limit.
    const added = await this.db.run(
      "INSERT INTO attempts SELECT ?,? WHERE (SELECT count(*) FROM attempts " +
        "WHERE account=?) < CAST(? AS INTEGER)",
      [account, now, account, VALIDATION_LIMIT],
    );
    return added > 0;
  }
}

/** The account file kept in the state folder when the gateway runs on this machine. */
export const ACCOUNTS_FILE = "web-accounts.sqlite3";

export interface OpenAccountsOptions extends AccountStoreOptions {
  hosted: boolean;
  /** The gateway's database; hosted accounts live in it. */
  db?: Database;
  stateDir: string;
  realm: string;
  env?: Record<string, string | undefined>;
}

/**
 * Opens the account store where it belongs: hosted, on the gateway's database, so every
 * process serving the deployment sees the same people; locally, in its own owner-only file in
 * the state folder. `close` closes only a file this call opened.
 */
export async function openAccountStore(
  opts: OpenAccountsOptions,
): Promise<{ store: AccountStore; close: () => Promise<void> }> {
  const key = (opts.env ?? process.env)[MASTER_KEY_VARIABLE] ?? "";
  masterKey({ [MASTER_KEY_VARIABLE]: key });
  if (opts.hosted) {
    if (!opts.db) throw new Error("Hosted accounts need the gateway database");
    const store = await AccountStore.open(opts.db, opts.realm, key, opts);
    return { store, close: async () => {} };
  }
  const path = join(opts.stateDir, ACCOUNTS_FILE);
  const db = new SqliteDatabase(path);
  try {
    chmodSync(path, 0o600);
    await db.run("PRAGMA foreign_keys=ON");
    const store = await AccountStore.open(db, opts.realm, key, opts);
    return { store, close: () => db.close() };
  } catch (error) {
    await db.close();
    throw error;
  }
}
