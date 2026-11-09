/** Named events that wake a bot's event jobs, once per delivery. */

import type { Database } from "../db/database.js";

const EVENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Queued wake-ups plus matching jobs one person may hold. */
export const MAX_QUEUED = 1000;

export interface Wakeup {
  event: string;
  delivery: string;
  received: number;
  claimed: number | null;
  finished: number | null;
  status: string;
}

const nullable = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** Whether wake-ups and scheduled claims are on; true until someone turns them off. */
export async function automationEnabled(db: Database, instance: string): Promise<boolean> {
  const rows = await db.query("SELECT enabled FROM job_automation WHERE instance=?", [instance]);
  return rows[0] ? Number(rows[0].enabled) !== 0 : true;
}

export async function setAutomation(db: Database, instance: string, on: boolean): Promise<void> {
  await db.run(
    "INSERT INTO job_automation(instance,enabled) VALUES(?,?) ON CONFLICT(instance) " +
      "DO UPDATE SET enabled=excluded.enabled",
    [instance, on ? 1 : 0],
  );
}

/**
 * Queues one wake-up for each active job of `actor` waiting on the event `name`. The delivery
 * receipt is the deduplication: only the first delivery of an ID goes on. Gives "off" while
 * automation is off, "duplicate" for a delivery already seen and "unknown" when no active job
 * waits on that event. Throws for a malformed name or delivery ID, or when the queue is full
 * (the receipt is dropped then, so the same delivery can be sent again).
 */
export async function receiveWakeup(
  db: Database,
  instance: string,
  actor: number,
  name: string,
  delivery: string,
  now: number = Date.now() / 1000,
): Promise<"queued" | "duplicate" | "off" | "unknown"> {
  if (typeof name !== "string" || !EVENT_NAME.test(name)) {
    throw new Error("Give an event name of lowercase letters, digits, dots or dashes");
  }
  if (typeof delivery !== "string" || !DELIVERY_ID.test(delivery)) {
    throw new Error("Give a delivery ID that stays the same, at most 128 characters");
  }
  if (!(await automationEnabled(db, instance))) return "off";
  const fresh = await db.run(
    "INSERT OR IGNORE INTO job_event_receipts(instance,actor,event,delivery,received) " +
      "VALUES(?,?,?,?,?)",
    [instance, actor, name, delivery, now],
  );
  if (fresh === 0) return "duplicate";
  const queued = Number(
    (
      await db.query(
        "SELECT count(*) AS n FROM job_wakeups WHERE instance=? AND actor=? AND status='queued'",
        [instance, actor],
      )
    )[0]?.n ?? 0,
  );
  const targets = await db.query(
    "SELECT id FROM jobs WHERE instance=? AND actor=? AND status='active' AND spec=?",
    [instance, actor, `event:${name}`],
  );
  if (queued + targets.length > MAX_QUEUED) {
    await db.run(
      "DELETE FROM job_event_receipts WHERE instance=? AND actor=? AND event=? AND delivery=?",
      [instance, actor, name, delivery],
    );
    throw new Error("The queue of automatic wake-ups is full");
  }
  for (const target of targets) {
    await db.run(
      "INSERT INTO job_wakeups(instance,actor,job,event,delivery,received) VALUES(?,?,?,?,?,?)",
      [instance, actor, Number(target.id), name, delivery, now],
    );
  }
  return targets.length > 0 ? "queued" : "unknown";
}

/** The latest 20 wake-ups of a job, newest first. */
export async function wakeupHistory(
  db: Database,
  instance: string,
  jobId: number,
): Promise<Wakeup[]> {
  const rows = await db.query(
    "SELECT event,delivery,received,claimed,finished,status FROM job_wakeups " +
      "WHERE instance=? AND job=? ORDER BY id DESC LIMIT 20",
    [instance, jobId],
  );
  return rows.map((row) => ({
    event: String(row.event),
    delivery: String(row.delivery),
    received: Number(row.received),
    claimed: nullable(row.claimed),
    finished: nullable(row.finished),
    status: String(row.status),
  }));
}
