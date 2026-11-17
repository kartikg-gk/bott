import { ConstraintError, type Database, inlineNulls, type Param, type Row } from "./database.js";

const D1_TIMEOUT_MS = 30_000;

type D1Result = { success?: boolean; results?: Row[]; meta?: { changes?: number } };
type D1Payload = { success?: unknown; errors?: unknown; result?: unknown };

function asText(value: Param): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

/** Cloudflare D1 through its HTTP query endpoint. */
export class D1Database implements Database {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    token: string,
    account: string,
    databaseId: string,
    opts: { fetch?: typeof fetch } = {},
  ) {
    this.url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(databaseId)}/query`;
    this.token = token;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async execute(sql: string, params: Param[]): Promise<D1Result[]> {
    const [text, kept] = inlineNulls(sql, params);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql: text, params: kept.map(asText) }),
        signal: AbortSignal.timeout(D1_TIMEOUT_MS),
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`D1 query failed after the request timed out after ${D1_TIMEOUT_MS / 1000} s`);
      }
      throw new Error(`D1 query failed: ${name}`);
    }
    const status = `D1 query failed, HTTP ${response.status}`;
    let payload: D1Payload;
    try {
      payload = (await response.json()) as D1Payload;
    } catch {
      throw new Error(`${status}: response was not JSON.`);
    }
    if (typeof payload !== "object" || payload === null || typeof payload.success !== "boolean") {
      throw new Error(`${status}: response was not understood.`);
    }
    const results = payload.result;
    let failed = !response.ok || !payload.success;
    if (
      !failed &&
      (!Array.isArray(results) ||
        !results.every((item) => typeof item === "object" && item !== null && item.success))
    ) {
      failed = true;
    }
    if (failed) {
      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      const details = errors
        .filter(
          (error): error is { message?: unknown } => typeof error === "object" && error !== null,
        )
        .map((error) => String(error.message ?? ""))
        .join("; ");
      const message = details ? `${status}: ${details}` : `${status}.`;
      if (details.toLowerCase().includes("constraint failed")) throw new ConstraintError(message);
      throw new Error(message);
    }
    return results as D1Result[];
  }

  async query(sql: string, params: Param[] = []): Promise<Row[]> {
    const results = await this.execute(sql, params);
    // D1 returns a BLOB as an array of byte values.
    return results.flatMap((item) =>
      (item.results ?? []).map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            Array.isArray(value) ? Uint8Array.from(value as number[]) : value,
          ]),
        ),
      ),
    );
  }

  async run(sql: string, params: Param[] = []): Promise<number> {
    const results = await this.execute(sql, params);
    return results.reduce((sum, item) => sum + Number(item.meta?.changes ?? 0), 0);
  }

  async check(): Promise<void> {
    await this.query("SELECT 1 AS ok");
  }

  async close(): Promise<void> {}
}
