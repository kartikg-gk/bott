/**
 * `db check` and `db import`.
 *
 * Import takes one instance out of a SQLite file on this machine and adds it to another
 * database, normally the hosted D1 one. The file is never written. Rows keep their own ids and
 * owners; a row whose key the target already has is skipped, which makes a repeated import
 * harmless. The one exception is an id another instance already holds in the target, which is
 * moved as `planIds` describes. Notes and skills, kept as files on this machine, are turned
 * into the rows a hosted gateway reads instead (`bot_memory`, `skill_files`). Locks held by
 * running processes mean nothing elsewhere, so they are not taken. Saved sessions are not taken
 * either: a hosted run is seeded from the conversation the browser sends with it.
 *
 * Importing the accounts moves everyone who signed in on this machine at once, each with the
 * instance that serves them; see `importAccounts`.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { associatedData, MASTER_KEY_VARIABLE, masterKey, Sealer } from "../accounts/sealing.ts";
import { ACCOUNTS_FILE, AccountStore } from "../accounts/store.ts";
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

/** Opens a local file for reading, refusing one this build does not read. */
function openLocal(source: string): BetterSqlite3.Database {
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
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The instance's rows in an open file, by table, in the order the schema made the tables. */
function rowsOf(db: BetterSqlite3.Database, instance: string): LocalRows {
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
}

/** Reads the instance's rows out of a local file that must hold it. */
function readLocal(source: string, instance: string): LocalRows {
  const db = openLocal(source);
  try {
    if (!db.prepare("SELECT 1 FROM instances WHERE id=?").get(instance)) {
      throw new ImportError(`Instance ${instance} is not in ${source}`);
    }
    return rowsOf(db, instance);
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

/** Refuses a target that holds bots for the instance that the local rows lack. */
async function checkBots(target: Database, instance: string, local: LocalRows): Promise<void> {
  const localBots = (local.tables.get("bots") ?? []).map((row) => String(row.id));
  const hosted = await target.query("SELECT id FROM bots WHERE instance=?", [instance]);
  if (hosted.some((row) => !localBots.includes(String(row.id)))) {
    throw new ImportError(
      `Instance ${instance} already has bots in the target that the SQLite file does not; ` +
        "pick a target database without them",
    );
  }
}

/** Inserts each row the target lacks, keeping ids, and counts how many were new. */
async function insertRows(target: Database, table: string, rows: Row[]): Promise<Count> {
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
  return { copied, there: rows.length - copied };
}

/** Columns that hold another row's id, by table, with the table that row is in. */
const POINTERS: Record<string, Record<string, string>> = {
  route_bots: { route: "routes" },
  messages: { route: "routes" },
  delegations: { route: "routes" },
  job_wakeups: { job: "jobs" },
  memory_facts: { replaces: "memory_facts", conflict: "memory_facts" },
};

/** Ids up to this size can be moved into an instance's own range. */
const ID_SPAN = 2n ** 32n;
/** How many ranges there are; the highest id stays below 2^53, so it is exact as a number. */
const ID_RANGES = 2n ** 20n - 1n;
/** D1 takes at most 100 bound values in one statement. */
const ID_BATCH = 45;

/**
 * Where an instance's ids go when another instance already holds them: a range of its own,
 * picked from its name, so a repeated import makes the same choice.
 */
function ownRange(instance: string): bigint {
  const hash = BigInt(`0x${createHash("sha256").update(instance, "utf8").digest("hex")}`);
  return ((hash % ID_RANGES) + 1n) * ID_SPAN;
}

/** Ids already given out in this run, by table, with the instance each went to. */
type Claimed = Map<string, Map<string, string>>;

/** The new id for each local row id that must change, by table. */
interface IdPlan {
  ids: Map<string, Map<string, bigint>>;
}

/**
 * Some tables number their rows across every instance in a database, and each local file
 * numbered its own from 1. An id the target already gives another instance's row is moved into
 * this instance's own range, and the columns pointing at it follow. An id that is free, or
 * already this instance's, is kept, as is one whose moved place this instance already holds:
 * that is where an earlier import put it.
 */
async function planIds(
  target: Database,
  instance: string,
  local: LocalRows,
  claimed: Claimed = new Map(),
): Promise<IdPlan> {
  const plan: IdPlan = { ids: new Map() };
  const base = ownRange(instance);
  for (const [table, rows] of local.tables) {
    if (rows.length === 0) continue;
    const columns = await target.query(`SELECT name,type,pk FROM pragma_table_info('${table}')`);
    const keys = columns.filter((column) => Number(column.pk) > 0);
    const numbered =
      keys.length === 1 &&
      keys[0]?.name === "id" &&
      String(keys[0]?.type).toUpperCase() === "INTEGER" &&
      columns.some((column) => column.name === "instance");
    if (!numbered) continue;
    const moved = new Map<string, bigint>();
    for (let start = 0; start < rows.length; start += ID_BATCH) {
      const batch = rows.slice(start, start + ID_BATCH).map((row) => BigInt(row.id as bigint));
      for (const id of batch) {
        if (id < 1n || id >= ID_SPAN) {
          throw new ImportError(
            `${table} row ${id} has an id too large to move; nothing was copied`,
          );
        }
      }
      const wanted = batch.flatMap((id) => [id, base + id]);
      const found = await target.query(
        `SELECT id,instance FROM "${table}" WHERE id IN (${wanted.map(() => "?").join(",")})`,
        wanted,
      );
      const owner = new Map(found.map((row) => [String(row.id), String(row.instance)]));
      // Ids that instances planned earlier in this run will take count as theirs already.
      const taken = claimed.get(table) ?? new Map<string, string>();
      claimed.set(table, taken);
      for (const id of wanted) {
        const by = taken.get(String(id));
        if (by !== undefined && !owner.has(String(id))) owner.set(String(id), by);
      }
      for (const id of batch) {
        const here = owner.get(String(id));
        const there = owner.get(String(base + id));
        if (there === instance || (here !== undefined && here !== instance)) {
          if (there !== undefined && there !== instance) {
            throw new ImportError(
              `${table} row ${id} has no free id in the target; nothing was copied`,
            );
          }
          moved.set(String(id), base + id);
          taken.set(String(base + id), instance);
        } else {
          taken.set(String(id), instance);
        }
      }
    }
    if (moved.size > 0) plan.ids.set(table, moved);
  }
  return plan;
}

/** The row with its own id and the ids it points at moved as the plan says. */
function renumber(table: string, row: Row, plan: IdPlan): Row {
  const own = plan.ids.get(table);
  const pointers = POINTERS[table] ?? {};
  const out = { ...row };
  if (own?.has(String(row.id))) out.id = own.get(String(row.id));
  for (const [column, parent] of Object.entries(pointers)) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    const moved = plan.ids.get(parent)?.get(String(value));
    if (moved !== undefined) out[column] = moved;
  }
  return out;
}

/** Adds an instance's rows, notes and skills to the target and returns the counts by table. */
async function copyInstance(
  target: Database,
  instance: string,
  local: LocalRows,
  plan: IdPlan,
  stateDir: string,
): Promise<Map<string, Count>> {
  const localBots = (local.tables.get("bots") ?? []).map((row) => String(row.id));
  const [notes, skills] = folderRows(stateDir, instance, localBots.sort());
  local.tables.set("bot_memory", [...(local.tables.get("bot_memory") ?? []), ...notes]);
  local.tables.set("skill_files", [...(local.tables.get("skill_files") ?? []), ...skills]);

  const counts = new Map<string, Count>();
  for (const [table, rows] of local.tables) {
    if (rows.length === 0) continue;
    const placed = rows.map((row) => renumber(table, row, plan));
    counts.set(table, await insertRows(target, table, placed));
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
  return counts;
}

function report(counts: Map<string, Count>, out: Out, indent = ""): void {
  for (const [table, count] of counts) {
    out(
      table === "memory_index_epochs"
        ? `${indent}memory_index_epochs: started a fresh index, rebuilt from the facts on first use`
        : `${indent}${table}: added ${count.copied}, skipped ${count.there} present before`,
    );
  }
}

function reportMoved(plan: IdPlan, out: Out, indent = ""): void {
  for (const [table, moved] of plan.ids) {
    out(`${indent}${table}: ${moved.size} given new ids, since the target used theirs already`);
  }
}

/** Copies the local instance into the target and returns, per table, what was copied. */
export async function importLocal(opts: ImportOptions): Promise<Map<string, Count>> {
  const { target, instance, out } = opts;
  const local = readLocal(opts.source, instance);
  await ensureSchema(target);
  await checkBots(target, instance, local);
  const plan = await planIds(target, instance, local);
  const counts = await copyInstance(target, instance, local, plan, opts.stateDir);
  report(counts, out);
  reportMoved(plan, out);
  if (counts.size === 0) out("The instance has no rows to add.");
  return counts;
}

export interface AccountsImportOptions {
  /** The local state folder: the account file, and each account's folder under web-users. */
  stateDir: string;
  /** The gateway's own file, which keeps each account's request and spend counts. */
  sharedFile: string;
  /** The instance name the credentials are sealed for; the hosted gateway must use the same. */
  realm: string;
  /** The master key that sealed them, which the hosted gateway must also use. */
  key: string | undefined;
  target: Database;
  out: Out;
}

export interface AccountsCounts {
  /** `accounts` and `credentials`. */
  accounts: Map<string, Count>;
  /** Per account instance, by table. */
  instances: Map<string, Map<string, Count>>;
}

/** Account rows worth moving. Sign-in sessions, pending sign-ins and key checks stay behind. */
const ACCOUNT_TABLES = ["accounts", "credentials"] as const;

/** Reads the people and their sealed credentials out of the local account file. */
function readAccounts(stateDir: string): { accounts: Row[]; credentials: Row[] } {
  const path = join(stateDir, ACCOUNTS_FILE);
  if (!existsSync(path)) throw new ImportError(`There are no local accounts at ${path}`);
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    return {
      accounts: db.prepare("SELECT * FROM accounts ORDER BY rowid").all() as Row[],
      credentials: db.prepare("SELECT * FROM credentials ORDER BY rowid").all() as Row[],
    };
  } finally {
    db.close();
  }
}

/** Proves each credential opens with this key and instance name, as the hosted gateway will. */
function checkSealed(credentials: Row[], realm: string, key: string | undefined): void {
  let sealer: Sealer;
  try {
    sealer = new Sealer(masterKey({ [MASTER_KEY_VARIABLE]: key ?? "" }));
  } catch (error) {
    throw new ImportError((error as Error).message);
  }
  for (const row of credentials) {
    try {
      // The opened value is dropped straight away; only whether it opens matters.
      sealer.open(
        row.sealed as Uint8Array,
        associatedData(realm, String(row.account), String(row.kind), String(row.name)),
      );
    } catch {
      throw new ImportError(
        "The saved credentials do not open with this BOTT_MASTER_KEY and BOTT_INSTANCE; " +
          "import with the two the local gateway uses, and give the hosted gateway the same",
      );
    }
  }
}

/**
 * Copies every account kept on this machine: the account list, the sealed credentials as they
 * are, and each account's own instance (its file, its notes and skills, and its counts in the
 * shared file). Nothing is written until every local file has been read and every check passed:
 * the credentials must open with this master key and instance name, nobody may already have a
 * different account in the target, and no account's instance may hold other bots there.
 */
export async function importAccounts(opts: AccountsImportOptions): Promise<AccountsCounts> {
  const { stateDir, target, out } = opts;
  const { accounts, credentials } = readAccounts(stateDir);
  checkSealed(credentials, opts.realm, opts.key);

  const shared = existsSync(opts.sharedFile) ? openLocal(opts.sharedFile) : null;
  const plans: { account: Row; instance: string; local: LocalRows }[] = [];
  try {
    for (const account of accounts) {
      const instance = String(account.id).replaceAll("-", "").toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(instance)) {
        throw new ImportError(`Account ${String(account.email)} has an id this build cannot use`);
      }
      const own = join(stateDir, "web-users", instance, "gateway.sqlite3");
      // Someone who signed in but never opened their gateway has no file yet.
      const local: LocalRows = existsSync(own)
        ? readLocal(own, instance)
        : { tables: new Map(), epoch: null };
      if (shared) {
        for (const [table, rows] of rowsOf(shared, instance).tables) {
          local.tables.set(table, [...(local.tables.get(table) ?? []), ...rows]);
        }
      }
      plans.push({ account, instance, local });
    }
  } finally {
    shared?.close();
  }

  await ensureSchema(target);
  const hasAccounts = await target.query(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounts'",
  );
  if (hasAccounts.length > 0) {
    for (const { account } of plans) {
      const found = await target.query("SELECT id FROM accounts WHERE subject=?", [
        account.subject as Param,
      ]);
      if (found[0] !== undefined && String(found[0].id) !== String(account.id)) {
        throw new ImportError(
          `${String(account.email)} already has another account in the target; ` +
            "pick a target database without it",
        );
      }
    }
  }
  const placed: IdPlan[] = [];
  const claimed: Claimed = new Map();
  for (const { instance, local } of plans) {
    await checkBots(target, instance, local);
    placed.push(await planIds(target, instance, local, claimed));
  }

  // The account tables, made the way the hosted gateway makes them.
  await AccountStore.open(target, opts.realm, opts.key ?? "");
  const counts: AccountsCounts = { accounts: new Map(), instances: new Map() };
  const rows = { accounts, credentials };
  for (const table of ACCOUNT_TABLES) {
    counts.accounts.set(table, await insertRows(target, table, rows[table]));
  }
  report(counts.accounts, out);
  for (const [index, { account, instance, local }] of plans.entries()) {
    const plan = placed[index] as IdPlan;
    const folder = join(stateDir, "web-users", instance);
    const copied = await copyInstance(target, instance, local, plan, folder);
    counts.instances.set(instance, copied);
    out(`${String(account.email)} (${instance}):`);
    report(copied, out, "  ");
    reportMoved(plan, out, "  ");
    if (copied.size === 0) out("  nothing to add");
  }
  return counts;
}
