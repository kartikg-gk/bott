import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import { ensureSchema } from "../db/schema.js";
import type { StoreContext } from "./context.js";
import { recoveryStatements } from "./recovery.js";

const CHIEF_NAME = "Chief of Staff";
const CHIEF_ROLE = "The main bot for this person.";
const APPROVAL_DAYS = 30;
const DAY = 86400;

export interface StoreOptions {
  retentionDays?: number;
  /** Settle work a stopped process left. Only the process that owns scheduled work should. */
  recover?: boolean;
  /** Seconds since the epoch, as a float. */
  clock?: () => number;
}

export class Store {
  private constructor(
    readonly ctx: StoreContext,
    private readonly retentionDays: number | undefined,
  ) {}

  /** Opens the store on any database, makes sure the instance has one chief, and may recover. */
  static async open(db: Database, instance: string, opts: StoreOptions = {}): Promise<Store> {
    const clock = opts.clock ?? (() => Date.now() / 1000);
    const store = new Store({ db, instance, clock }, opts.retentionDays);
    await ensureSchema(db);
    await db.run("INSERT OR IGNORE INTO instances(id) VALUES (?)", [instance]);
    if (opts.recover ?? true) await store.recover();
    await db.run(
      "INSERT INTO bots(id,instance,name,name_key,role,chief,created) " +
        "SELECT ?,?,?,?,?,1,? WHERE NOT EXISTS (SELECT 1 FROM bots WHERE instance=? AND chief=1)",
      [
        randomUUID().replaceAll("-", ""),
        instance,
        CHIEF_NAME,
        CHIEF_NAME.toLowerCase(),
        CHIEF_ROLE,
        clock(),
        instance,
      ],
    );
    return store;
  }

  async chief(): Promise<{ id: string; name: string }> {
    const { db, instance } = this.ctx;
    const rows = await db.query("SELECT id,name FROM bots WHERE instance=? AND chief=1", [
      instance,
    ]);
    const row = rows[0];
    if (!row) throw new Error("The instance has no chief bot");
    return { id: String(row.id), name: String(row.name) };
  }

  async recover(): Promise<void> {
    const { db, instance, clock } = this.ctx;
    for (const [sql, params] of recoveryStatements(instance, clock())) await db.run(sql, params);
  }

  /** Drops text and rows older than the retention period; returns how many rows changed. */
  async retain(days?: number): Promise<number> {
    const keep = days ?? this.retentionDays;
    if (!keep) return 0;
    const { db, instance, clock } = this.ctx;
    const now = clock();
    const cutoff = now - keep * DAY;
    let changed = 0;
    changed += await db.run(
      "UPDATE inbox SET text=NULL WHERE instance=? AND created<? AND text IS NOT NULL " +
        "AND status IN ('completed','cancelled','dismissed','rejected_done')",
      [instance, cutoff],
    );
    changed += await db.run(
      "DELETE FROM approvals WHERE instance=? AND created<? AND decision IS NOT NULL",
      [instance, now - APPROVAL_DAYS * DAY],
    );
    changed += await db.run("DELETE FROM web_runs WHERE instance=? AND finished<?", [
      instance,
      cutoff,
    ]);
    changed += await db.run("DELETE FROM messages WHERE instance=? AND created<?", [
      instance,
      cutoff,
    ]);
    return changed;
  }
}
