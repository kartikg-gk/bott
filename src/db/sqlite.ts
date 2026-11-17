import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { ConstraintError, type Database, inlineNulls, type Param, type Row } from "./database.js";

const BUSY_TIMEOUT_MS = 30_000;

function bindable(value: Param): string | number | bigint | Buffer {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as string | number | bigint;
}

/** A SQLite file. better-sqlite3 is synchronous, so methods are async only by interface. */
export class SqliteDatabase implements Database {
  private readonly connection: BetterSqlite3.Database;

  constructor(readonly path: string) {
    if (path !== ":memory:" && path !== "") mkdirSync(dirname(path), { recursive: true });
    this.connection = new BetterSqlite3(path, { timeout: BUSY_TIMEOUT_MS });
    this.useWal();
    this.connection.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }

  /**
   * Switches the file to write-ahead logging. The switch needs the file to itself, and when
   * another process opening it holds a lock too, SQLite reports busy at once rather than
   * waiting, since neither could go on. So it is tried again for as long as a busy wait lasts.
   */
  private useWal(): void {
    const until = Date.now() + BUSY_TIMEOUT_MS;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        this.connection.pragma("journal_mode = WAL");
        return;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code !== "SQLITE_BUSY" || Date.now() >= until) throw error;
        Atomics.wait(pause, 0, 0, 10 + Math.random() * 40);
      }
    }
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

  /**
   * Runs `work` holding the file's write lock, as one transaction: either everything it wrote
   * lands or none of it does. Another process wanting the lock waits for it, so what `work`
   * reads is still true when it writes. Nothing else may use this connection meanwhile.
   */
  async locked<T>(work: () => Promise<T>): Promise<T> {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = await work();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.connection.inTransaction) this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  /** Writes a consistent copy of the whole file to `target`, readable by its owner only. */
  async copyTo(target: string): Promise<void> {
    await this.connection.backup(target);
    try {
      chmodSync(target, 0o600);
    } catch {
      // Some file systems keep no modes; the copy is there all the same.
    }
  }

  async check(): Promise<void> {
    await this.query("SELECT 1 AS ok");
  }

  async close(): Promise<void> {
    this.connection.close();
  }
}
