import { randomUUID } from "node:crypto";
import type { Database } from "./database.js";

/**
 * A named lease in the shared database, for processes that cannot share a file lock. It lasts
 * `ttlSeconds` unless renewed; a holder that stops renewing loses it once it runs out.
 * `clock` returns milliseconds, like Date.now.
 */
export class Lease {
  readonly owner = randomUUID().replaceAll("-", "");
  private readonly ttlSeconds: number;
  private readonly clock: () => number;

  constructor(
    private readonly db: Database,
    readonly name: string,
    opts: { ttlSeconds?: number; clock?: () => number } = {},
  ) {
    this.ttlSeconds = opts.ttlSeconds ?? 60;
    this.clock = opts.clock ?? Date.now;
  }

  private now(): number {
    return this.clock() / 1000;
  }

  /** True when this holder now has the lease: it was free, or the last holder's time ran out. */
  async acquire(): Promise<boolean> {
    const expires = this.now() + this.ttlSeconds;
    const inserted = await this.db.run("INSERT OR IGNORE INTO leases VALUES (?, ?, ?)", [
      this.name,
      this.owner,
      expires,
    ]);
    if (inserted > 0) return true;
    const taken = await this.db.run(
      "UPDATE leases SET owner = ?, expires = ? WHERE name = ? AND expires <= ?",
      [this.owner, expires, this.name, this.now()],
    );
    return taken > 0;
  }

  /** False when someone else holds the lease now. */
  async renew(): Promise<boolean> {
    const renewed = await this.db.run(
      "UPDATE leases SET expires = ? WHERE name = ? AND owner = ?",
      [this.now() + this.ttlSeconds, this.name, this.owner],
    );
    return renewed > 0;
  }

  async release(): Promise<void> {
    await this.db.run("DELETE FROM leases WHERE name = ? AND owner = ?", [this.name, this.owner]);
  }
}
