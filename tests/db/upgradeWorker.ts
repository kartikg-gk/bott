/**
 * Opens one database file and brings it up to date, as a separate process would when it
 * starts. Waits until the given start time first, so several of these begin together.
 * Usage: upgradeWorker.ts <file> <start ms>
 */

import { ensureSchema } from "../../src/db/schema.ts";
import { SqliteDatabase } from "../../src/db/sqlite.ts";

const [path, start] = process.argv.slice(2);
const db = new SqliteDatabase(path as string);
while (Date.now() < Number(start)) {
  // Spin rather than sleep: a timer could start this process a few milliseconds late.
}
try {
  await ensureSchema(db);
  process.stdout.write("upgraded\n");
} finally {
  await db.close();
}
