import BetterSqlite3 from "better-sqlite3";
import { D1Database } from "../../src/db/d1.js";
import type { Database } from "../../src/db/database.js";
import { SqliteDatabase } from "../../src/db/sqlite.js";

export const ACCOUNT = "account-1";
export const DATABASE_ID = "database-1";
export const TOKEN = "token-1";
export const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE_ID}/query`;

export type Backend = "sqlite" | "d1";
export const backends: Backend[] = ["sqlite", "d1"];

type Body = { sql: string; params: unknown[] };

/** Answers the D1 /query endpoint from an in-memory SQLite database, with D1's response shape. */
export class FakeD1 {
  readonly connection: BetterSqlite3.Database;
  readonly requests: Body[] = [];
  /** Answers in place of the database when it returns a response; undefined lets it answer. */
  fault: ((request: Request) => Response | undefined | Promise<Response | undefined>) | null = null;

  /** Kept in memory unless a file is named, as when a test starts from an existing database. */
  constructor(path = ":memory:") {
    this.connection = new BetterSqlite3(path);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url !== ENDPOINT) throw new Error(`unexpected URL ${request.url}`);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ success: false, errors: [{ message: "bad token" }] }, { status: 403 });
    }
    const body = (await request.json()) as Body;
    this.requests.push(body);
    if (this.fault) {
      const answer = await this.fault(request);
      if (answer) return answer;
    }
    try {
      const statement = this.connection.prepare(body.sql);
      let results: Record<string, unknown>[] = [];
      let changes = 0;
      if (statement.reader) {
        results = (statement.all(...body.params) as Record<string, unknown>[]).map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array ? Array.from(value) : value,
            ]),
          ),
        );
      } else {
        changes = statement.run(...body.params).changes;
      }
      return Response.json({
        success: true,
        errors: [],
        result: [{ success: true, results, meta: { changes } }],
      });
    } catch (error) {
      return Response.json(
        { success: false, errors: [{ code: 7500, message: (error as Error).message }] },
        { status: 400 },
      );
    }
  };

  database(): D1Database {
    return new D1Database(TOKEN, ACCOUNT, DATABASE_ID, { fetch: this.fetch });
  }
}

/** A fresh database on the chosen backend, for tests run on both. */
export function database(kind: Backend): { db: Database; fake: FakeD1 | null } {
  if (kind === "sqlite") return { db: new SqliteDatabase(":memory:"), fake: null };
  const fake = new FakeD1();
  return { db: fake.database(), fake };
}
