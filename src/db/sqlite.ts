import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { ConstraintError, type Database, inlineNulls, type Param, type Row } from "./database.js";

const BUSY_TIMEOUT_MS = 30_000;

function bindable(value: Param): string | number | bigint | Buffer {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as string | number;
}

/** A SQLite file. better-sqlite3 is synchronous, so methods are async only by interface. */
export class SqliteDatabase implements Database {
  private readonly connection: BetterSqlite3.Database;

  constructor(path: string) {
    if (path !== ":memory:" && path !== "") mkdirSync(dirname(path), { recursive: true });
    this.connection = new BetterSqlite3(path, { timeout: BUSY_TIMEOUT_MS });
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }

  private execute(sql: string, params: Param[]): { rows: Row[]; changes: number } {
    const [text, kept] = inlineNulls(sql, params);
    try {
      const statement = this.connection.prepare(text);
      const values = kept.map(bindable);
      if (statement.reader) {
        const rows = (statement.all(...values) as Row[]).map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array ? new Uint8Array(value) : value,
            ]),
          ),
        );
        return { rows, changes: 0 };
      }
      return { rows: [], changes: statement.run(...values).changes };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
        throw new ConstraintError((error as Error).message);
      }
      throw error;
    }
  }

  async query(sql: string, params: Param[] = []): Promise<Row[]> {
    return this.execute(sql, params).rows;
  }

  async run(sql: string, params: Param[] = []): Promise<number> {
    return this.execute(sql, params).changes;
  }

  async check(): Promise<void> {
    await this.query("SELECT 1 AS ok");
  }

  async close(): Promise<void> {
    this.connection.close();
  }
}
