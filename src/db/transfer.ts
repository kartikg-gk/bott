/**
 * `db check` and `db import`.
 *
 * Import takes one instance out of a SQLite file on this machine and adds it to another
 * database, normally the hosted D1 one. The file is never written. Rows keep their own ids and
 * owners; a row whose key the target already has is skipped, which makes a repeated import
 * harmless. Notes and skills, kept as files on this machine, are turned into the rows a hosted
 * gateway reads instead (`bot_memory`, `skill_files`). Locks held by running processes mean
 * nothing elsewhere, so they are not taken. Saved sessions are not taken either: a hosted run is
 * seeded from the conversation the browser sends with it.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { MEMORY_FILES } from "../bots/bots.ts";
import type { Database, Param, Row } from "./database.ts";
import { ensureSchema, SCHEMA_VERSION } from "./schema.ts";
import { databaseStatus, SCHEMA_MARK } from "./status.ts";

/** Tables that are never copied: bookkeeping, live locks and the memory index generation. */
const LEFT_BEHIND = new Set([
  "sqlite_sequence",
  "schema_migrations",
  "leases",
  "scheduler_leases",
  "memory_index_epochs",
]);

export type Out = (line: string) => void;

/** Prints the backend, that it answers and the schema it holds. Writes nothing. */
export async function checkDatabase(db: Database, out: Out): Promise<void> {
  const status = await databaseStatus(db);
  const schema = status.schema ? `schema ${status.schema}` : "no schema";
  out(`${status.backend} answers; it holds ${schema}, and this build expects ${SCHEMA_MARK}`);
}

/** A problem with the import that the person running it can fix. */
export class ImportError extends Error {
  override name = "ImportError";
}

interface LocalRows {
  tables: Map<string, Row[]>;
  /** The local memory index generation, which the target must not share. */
  epoch: string | null;
}

/** Reads the instance's rows by table, in the order the schema made the tables. */
function readLocal(source: string, instance: string): LocalRows {
  if (!existsSync(source)) throw new ImportError(`There is no SQLite file at ${source}`);
  const db = new BetterSqlite3(source, { readonly: true, fileMustExist: true });
  try {
    // Exact integers: some ids are larger than a double holds.
    db.defaultSafeIntegers(true);
    const version = Number(db.pragma("user_version", { simple: true }));
    if (version !== SCHEMA_VERSION) {
      const age = version < SCHEMA_VERSION ? "older" : "newer";
      throw new ImportError(
        `${source} uses schema ${version}, ${age} than the ${SCHEMA_VERSION} this build ` +
          "reads; start this build on it once, then import",
      );
    }
    if (!db.prepare("SELECT 1 FROM instances WHERE id=?").get(instance)) {
      throw new ImportError(`Instance ${instance} is not in ${source}`);
    }
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY rowid").all() as {
        name: string;
      }[]
    )
      .map((row) => row.name)
      .filter((name) => !LEFT_BEHIND.has(name));
    const tables = new Map<string, Row[]>();
    for (const table of names) {
      const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
        (column) => column.name,
      );
      let sql: string;
      if (table === "instances") sql = "SELECT * FROM instances WHERE id=?";
      else if (table === "route_bots") {
        sql =
          "SELECT route_bots.* FROM route_bots JOIN routes ON routes.id=route_bots.route " +
          "WHERE routes.instance=?";
      } else if (columns.includes("instance")) sql = `SELECT * FROM "${table}" WHERE instance=?`;
      else continue;
      tables.set(table, db.prepare(sql).all(instance) as Row[]);
    }
    const epoch = db
      .prepare("SELECT epoch FROM memory_index_epochs WHERE instance=?")
      .get(instance) as { epoch: string } | undefined;
    return { tables, epoch: epoch?.epoch ?? null };
  } finally {
    db.close();
  }
}

function files(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...files(path));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

/** The notes and skill folders on disk, as `bot_memory` and `skill_files` rows. */
function folderRows(stateDir: string, instance: string, bots: string[]): [Row[], Row[]] {
  const now = Date.now() / 1000;
  const notes: Row[] = [];
  const skills: Row[] = [];
  // The instance-wide skills, then each bot's own skills and notes.
  const places: { scope: string; skillDir: string; notesDir: string | null }[] = [
    { scope: "", skillDir: join(stateDir, "skills"), notesDir: null },
    ...bots.map((bot) => ({
      scope: bot,
      skillDir: join(stateDir, "bots", bot, "skills"),
      notesDir: join(stateDir, "bots", bot, "memory"),
    })),
  ];
  for (const { scope, skillDir, notesDir } of places) {
    if (notesDir) {
      for (const file of MEMORY_FILES) {
        const path = join(notesDir, file);
        if (!existsSync(path)) continue;
        const content = readFileSync(path, "utf8");
        notes.push({ instance, bot: scope, file, content, updated: now });
      }
    }
    for (const path of files(skillDir)) {
      const [skill, ...rest] = relative(skillDir, path).split(sep);
      // A loose file beside the skill folders belongs to no skill.
      if (!skill || rest.length === 0) continue;
      const content = readFileSync(path, "utf8");
      skills.push({
        instance,
        scope,
        skill,
        path: rest.join("/"),
        content,
        revision: createHash("sha256").update(content, "utf8").digest("hex"),
      });
    }
  }
  return [notes, skills];
}

export interface ImportOptions {
  /** The local SQLite file. */
  source: string;
  instance: string;
  /** The local state folder holding the bots' notes and skills. */
  stateDir: string;
  target: Database;
  out: Out;
}

export interface Count {
  copied: number;
  there: number;
}

/** Copies the local instance into the target and returns, per table, what was copied. */
export async function importLocal(opts: ImportOptions): Promise<Map<string, Count>> {
  const { target, instance, out } = opts;
  const local = readLocal(opts.source, instance);
  const localBots = (local.tables.get("bots") ?? []).map((row) => String(row.id));
  await ensureSchema(target);
  const hosted = await target.query("SELECT id FROM bots WHERE instance=?", [instance]);
  if (hosted.some((row) => !localBots.includes(String(row.id)))) {
    throw new ImportError(
      "This instance already has bots in the target that the SQLite file does not; " +
        "pick a target database without them",
    );
  }
  const [notes, skills] = folderRows(opts.stateDir, instance, localBots.sort());
  local.tables.set("bot_memory", [...(local.tables.get("bot_memory") ?? []), ...notes]);
  local.tables.set("skill_files", [...(local.tables.get("skill_files") ?? []), ...skills]);

  const counts = new Map<string, Count>();
  for (const [table, rows] of local.tables) {
    if (rows.length === 0) continue;
    const known = new Set(
      (await target.query(`SELECT name FROM pragma_table_info('${table}')`)).map((row) =>
        String(row.name),
      ),
    );
    let copied = 0;
    for (const row of rows) {
      const names = Object.keys(row).filter((name) => known.has(name));
      const marks = names.map(() => "?").join(",");
      copied += await target.run(
        `INSERT OR IGNORE INTO "${table}"(${names.map((name) => `"${name}"`).join(",")}) ` +
          `VALUES(${marks})`,
        names.map((name) => row[name] as Param),
      );
    }
    counts.set(table, { copied, there: rows.length - copied });
  }

  // Copied facts are not in the target's search index, and the local index belongs to the local
  // file; either way the target starts a new generation, which rebuilds the index from its rows.
  const current = await target.query("SELECT epoch FROM memory_index_epochs WHERE instance=?", [
    instance,
  ]);
  const shared = current[0] !== undefined && String(current[0].epoch) === local.epoch;
  if ((counts.get("memory_facts")?.copied ?? 0) > 0 || shared) {
    await target.run("INSERT OR REPLACE INTO memory_index_epochs(instance,epoch) VALUES(?,?)", [
      instance,
      randomUUID().replaceAll("-", ""),
    ]);
    counts.set("memory_index_epochs", { copied: 1, there: 0 });
  }

  for (const [table, count] of counts) {
    out(
      table === "memory_index_epochs"
        ? "memory_index_epochs: started a fresh index, rebuilt from the facts on first use"
        : `${table}: added ${count.copied}, skipped ${count.there} present before`,
    );
  }
  if (counts.size === 0) out("The instance has no rows to add.");
  return counts;
}
