import type { Database } from "../db/database.js";

/** What every store module needs: the database, whose data it is, and the time in seconds. */
export interface StoreContext {
  db: Database;
  instance: string;
  /** Seconds since the epoch, as a float. */
  clock: () => number;
}
