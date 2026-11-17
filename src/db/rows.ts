import type { Database, Param, Row } from "./database.js";

const ATTEMPTS = 10;

/** The row kept changing under an update until the attempts ran out. */
export class ConflictError extends Error {
  override name = "ConflictError";
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.compare(a, b) === 0;
  return a === b;
}

/**
 * Compare-and-swap for rows several processes write. Reads the row, lets \`change\` edit a copy,
 * and writes only the changed columns if the row's \`version\` is still the one it read. A lost
 * race reads again and reapplies the change. Returns the row as written.
 */
export async function updateVersioned(
  db: Database,
  table: string,
  key: Row,
  change: (row: Row) => void | Promise<void>,
  opts: { attempts?: number } = {},
): Promise<Row> {
  const columns = Object.keys(key);
  const condition = columns.map((column) => `${column} = ?`).join(" AND ");
  const values = Object.values(key) as Param[];
  for (let attempt = 0; attempt < (opts.attempts ?? ATTEMPTS); attempt++) {
    const current = (await db.query(`SELECT * FROM ${table} WHERE ${condition}`, values))[0];
    if (!current) throw new Error(`No ${table} row ${JSON.stringify(key)}`);
    const row = { ...current };
    await change(row);
    const assignments = ["version = version + 1"];
    const params: Param[] = [];
    for (const [column, value] of Object.entries(row)) {
      if (column === "version" || columns.includes(column) || same(value, current[column]))
        continue;
      if (value === null || value === undefined) {
        assignments.push(`${column} = NULL`);
      } else {
        assignments.push(`${column} = ?`);
        params.push(value as Param);
      }
    }
    const landed = await db.run(
      `UPDATE ${table} SET ${assignments.join(", ")} WHERE ${condition} AND version = ?`,
      [...params, ...values, current.version as Param],
    );
    if (landed === 1) return { ...row, version: Number(current.version) + 1 };
  }
  throw new ConflictError(`${table} ${JSON.stringify(key)} kept changing; try again.`);
}
