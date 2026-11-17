import { D1Database } from "./d1.js";
import { SqliteDatabase } from "./sqlite.js";

export type Param = string | number | boolean | null | Uint8Array;
export type Row = Record<string, unknown>;

export interface Database {
  query(sql: string, params?: Param[]): Promise<Row[]>;
  /** Runs a write and returns how many rows it changed, so callers can detect lost races. */
  run(sql: string, params?: Param[]): Promise<number>;
  check(): Promise<void>;
  close(): Promise<void>;
}

/** A write broke a UNIQUE, NOT NULL, CHECK or foreign key rule. Same type on both backends. */
export class ConstraintError extends Error {
  override name = "ConstraintError";
}

/** The D1 settings are incomplete. */
export class DatabaseConfigError extends Error {
  override name = "DatabaseConfigError";
}

export const D1_VARIABLES = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_D1_DATABASE_ID",
] as const;

/**
 * Writes null as NULL and bytes as X'..' into the statement, skipping quoted text.
 * D1's HTTP API binds text only, so these two kinds of value become literals. Both backends do
 * it, so local and hosted runs execute the same SQL.
 */
export function inlineNulls(sql: string, params: Param[]): [string, Param[]] {
  if (params.every((value) => value !== null && !(value instanceof Uint8Array))) {
    return [sql, [...params]];
  }
  let out = "";
  const kept: Param[] = [];
  let index = 0;
  let quote: string | null = null;
  for (const char of sql) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "?") {
      const value = params[index++];
      if (value === null || value === undefined) {
        out += "NULL";
        continue;
      }
      if (value instanceof Uint8Array) {
        out += `X'${Buffer.from(value).toString("hex")}'`;
        continue;
      }
      kept.push(value);
    }
    out += char;
  }
  return [out, kept];
}

/** D1 when its database ID is set, otherwise the SQLite file at the configured path. */
export function createDatabase(
  config: { databasePath: string },
  env: Record<string, string | undefined> = process.env,
): Database {
  if (!(env.CLOUDFLARE_D1_DATABASE_ID ?? "").trim()) return new SqliteDatabase(config.databasePath);
  const missing = D1_VARIABLES.filter((name) => !(env[name] ?? "").trim());
  if (missing.length > 0) {
    throw new DatabaseConfigError(`Missing D1 configuration: ${missing.join(", ")}`);
  }
  const [token, account, databaseId] = D1_VARIABLES.map((name) => (env[name] ?? "").trim());
  return new D1Database(token as string, account as string, databaseId as string);
}
