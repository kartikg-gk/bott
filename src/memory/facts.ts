import type { Param, Row } from "../db/database.js";
import type { StoreContext } from "../store/context.js";

/** Stored with every fact so later prompt changes can be told apart. */
export const PROMPT_VERSION = 1;
/** A revision below this confidence opens a conflict instead of replacing the stored fact. */
export const UPDATE_CONFIDENCE = 0.9;
/** Failed index copies after which a fact waits for a retry. */
export const SYNC_ATTEMPTS = 3;
export const MAX_TEXT = 500;
/** Most facts a list returns. */
const LIST_LIMIT = 30;

/**
 * Where a fact stands. These strings are what existing databases hold, so they stay.
 * `active` facts are current; the others are history.
 */
export type FactStatus = "active" | "superseded" | "conflicted" | "retracted";
export type FactKind = "fact" | "episode";

/** Memory belongs to one project folder and one person. */
export interface Scope {
  project: string;
  owner: number;
}

export interface Fact {
  id: number;
  kind: string;
  text: string;
  tags: string[];
  confidence: number;
  source: string;
  status: string;
  /** Seconds since the epoch. */
  created: number;
  /** For conflicting versions, the number of the fact they disagree about. */
  conflict: number | null;
}

export interface FactDetails {
  source: string;
  confidence?: number;
  tags?: readonly string[];
  quote?: string | null;
  detail?: Record<string, string> | null;
  /** The id an outside extractor gave the fact. */
  external?: string | null;
}

/** A row waiting to be copied into the search index. */
export interface Unsynced {
  id: number;
  text: string;
  project: string;
  owner: number;
  status: string;
  /** When the row last changed; a copy counts only if the row has not changed since. */
  changed: number;
}

/** Refused memory changes; the message is meant for the person. */
export class MemoryError extends Error {
  override name = "MemoryError";
}

const FIELDS = "id,kind,text,tags,confidence,source,status,created,conflict";

function readTags(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toFact(row: Row): Fact {
  return {
    id: Number(row.id),
    kind: String(row.kind),
    text: String(row.text),
    tags: readTags(row.tags),
    confidence: Number(row.confidence),
    source: String(row.source),
    status: String(row.status),
    created: Number(row.created),
    conflict: row.conflict === null || row.conflict === undefined ? null : Number(row.conflict),
  };
}

const marks = (count: number) => Array.from({ length: count }, () => "?").join(",");

/**
 * Every fact and episode with its history, in `memory_facts`. The search index is built from
 * these rows and never the other way round.
 *
 * The database offers no transactions, so each change first moves the row it depends on with a
 * conditional update. When two changes race, one finds the row already moved and is refused.
 */
export class FactStore {
  constructor(private readonly ctx: StoreContext) {}

  /** Saves a current fact or episode; null when the same text is already current. */
  async add(
    scope: Scope,
    kind: FactKind,
    text: string,
    details: FactDetails,
  ): Promise<number | null> {
    const { db, instance } = this.ctx;
    const cut = text.slice(0, MAX_TEXT);
    const values = this.values(scope, kind, cut, "active", details, null, null);
    const rows = await db.query(
      `INSERT INTO memory_facts(${COLUMNS}) SELECT ${marks(values.length)} WHERE NOT EXISTS (` +
        "SELECT 1 FROM memory_facts WHERE instance=? AND project=? AND owner=? AND text=? " +
        "AND status='active') RETURNING id",
      [...values, instance, scope.project, scope.owner, cut],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  /** Saves what the person asked to be remembered. */
  async remember(scope: Scope, text: string): Promise<number> {
    const id = await this.add(scope, "fact", text, { source: "explicit", tags: ["fact"] });
    if (id === null) throw new MemoryError("That fact is already saved");
    return id;
  }

  /**
   * Replaces a current fact when the change is sure; otherwise holds both versions, neither
   * current, until the owner keeps one.
   */
  async revise(
    previous: number,
    scope: Scope,
    text: string,
    confidence: number,
    details: FactDetails,
  ): Promise<{ outcome: "superseded" | "conflict"; id: number }> {
    const old = await this.mine(previous, scope, "active");
    const sure = confidence >= UPDATE_CONFIDENCE;
    const { db, instance } = this.ctx;
    // The new version goes in as history first, so a failure here changes nothing current.
    const values = this.values(
      scope,
      old.kind,
      text.slice(0, MAX_TEXT),
      "superseded",
      { ...details, confidence },
      old.id,
      sure ? null : old.id,
    );
    const rows = await db.query(
      `INSERT INTO memory_facts(${COLUMNS}) VALUES(${marks(values.length)}) RETURNING id`,
      values,
    );
    const id = Number(rows[0]?.id);
    // One statement swaps both rows, and only while the old one is still current.
    const switched = await db.run(
      "UPDATE memory_facts SET status=CASE id WHEN ? THEN ? ELSE ? END" +
        (sure ? "" : ",conflict=CASE id WHEN ? THEN id ELSE conflict END") +
        ",changed=?,indexed=0,sync_errors=0 WHERE instance=? AND id IN (?,?) AND EXISTS (" +
        "SELECT 1 FROM memory_facts WHERE instance=? AND id=? AND status='active')",
      [
        old.id,
        sure ? "superseded" : "conflicted",
        sure ? "active" : "conflicted",
        ...(sure ? [] : [old.id]),
        this.ctx.clock(),
        instance,
        old.id,
        id,
        instance,
        old.id,
      ],
    );
    if (switched !== 2) {
      await db.run("DELETE FROM memory_facts WHERE instance=? AND id=? AND status='superseded'", [
        instance,
        id,
      ]);
      throw new MemoryError("There is no memory with that number");
    }
    return { outcome: sure ? "superseded" : "conflict", id };
  }

  /** Makes one conflicting version current and supersedes the others. */
  async keep(id: number, scope: Scope): Promise<void> {
    const chosen = await this.mine(id, scope, "conflicted");
    const { db, instance } = this.ctx;
    // The whole conflict group changes in one statement, and only while the choice is open.
    const moved = await db.run(
      "UPDATE memory_facts SET status=CASE id WHEN ? THEN 'active' ELSE 'superseded' END," +
        "changed=?,indexed=0,sync_errors=0 WHERE instance=? AND conflict=? AND status='conflicted' " +
        "AND EXISTS (SELECT 1 FROM memory_facts WHERE instance=? AND id=? AND status='conflicted')",
      [chosen.id, this.ctx.clock(), instance, chosen.conflict, instance, chosen.id],
    );
    if (moved === 0) throw new MemoryError("There is no memory with that number");
  }

  /** Retracts a current fact; `restore` brings it back. */
  async forget(id: number, scope: Scope): Promise<void> {
    await this.switch(id, scope, "active", "retracted");
  }

  async restore(id: number, scope: Scope): Promise<void> {
    await this.switch(id, scope, "retracted", "active");
  }

  /** Newest first, at most 30. */
  async facts(
    scope: Scope,
    opts: { statuses?: readonly string[]; kind?: string } = {},
  ): Promise<Fact[]> {
    const statuses = opts.statuses ?? ["active"];
    const kind = opts.kind ?? null;
    const rows = await this.ctx.db.query(
      `SELECT ${FIELDS} FROM memory_facts WHERE instance=? AND project=? AND owner=? ` +
        `AND status IN (${marks(statuses.length)}) AND (? IS NULL OR kind=?) ` +
        `ORDER BY id DESC LIMIT ${LIST_LIMIT}`,
      [this.ctx.instance, scope.project, scope.owner, ...statuses, kind, kind],
    );
    return rows.map(toFact);
  }

  /** The current facts among `ids`, in the order given. */
  async current(scope: Scope, ids: readonly number[]): Promise<Fact[]> {
    if (ids.length === 0) return [];
    const rows = await this.ctx.db.query(
      `SELECT ${FIELDS} FROM memory_facts WHERE instance=? AND project=? AND owner=? ` +
        `AND status='active' AND id IN (${marks(ids.length)})`,
      [this.ctx.instance, scope.project, scope.owner, ...ids],
    );
    const found = new Map(rows.map((row) => [Number(row.id), toFact(row)]));
    return ids.flatMap((id) => found.get(id) ?? []);
  }

  /** Any row, for checks and tests. */
  async row(id: number): Promise<Row | null> {
    const rows = await this.ctx.db.query("SELECT * FROM memory_facts WHERE instance=? AND id=?", [
      this.ctx.instance,
      id,
    ]);
    return rows[0] ?? null;
  }

  /** Facts the index could not take after every attempt. */
  async failed(scope: Scope): Promise<{ id: number; error: string | null }[]> {
    const rows = await this.ctx.db.query(
      "SELECT id,sync_error FROM memory_facts WHERE instance=? AND project=? AND owner=? " +
        "AND indexed=0 AND sync_errors>=? ORDER BY id",
      [this.ctx.instance, scope.project, scope.owner, SYNC_ATTEMPTS],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      error:
        row.sync_error === null || row.sync_error === undefined ? null : String(row.sync_error),
    }));
  }

  /** Gives failed facts their attempts back; returns how many wait for the index. */
  retry(scope: Scope): Promise<number> {
    return this.ctx.db.run(
      "UPDATE memory_facts SET sync_errors=0 WHERE instance=? AND project=? AND owner=? " +
        "AND indexed=0",
      [this.ctx.instance, scope.project, scope.owner],
    );
  }

  /** Rows the index has not taken yet, oldest first, skipping those out of attempts. */
  async unsynced(): Promise<Unsynced[]> {
    const rows = await this.ctx.db.query(
      "SELECT id,text,project,owner,status,changed FROM memory_facts WHERE instance=? " +
        "AND indexed=0 " +
        "AND sync_errors<? ORDER BY id",
      [this.ctx.instance, SYNC_ATTEMPTS],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      text: String(row.text),
      project: String(row.project),
      owner: Number(row.owner),
      status: String(row.status),
      changed: Number(row.changed),
    }));
  }

  /**
   * Records a finished copy. A row that changed while the copy was in flight stays queued, so
   * its newer state is copied on the next pass.
   */
  async markIndexed(row: Pick<Unsynced, "id" | "status" | "changed">): Promise<boolean> {
    const marked = await this.ctx.db.run(
      "UPDATE memory_facts SET indexed=1,sync_error=NULL WHERE instance=? AND id=? AND status=? " +
        "AND changed=?",
      [this.ctx.instance, row.id, row.status, row.changed],
    );
    return marked === 1;
  }

  /** Counts a failed copy, unless the row changed meanwhile and has fresh attempts. */
  async markFailed(row: Pick<Unsynced, "id" | "status" | "changed">, error: string): Promise<void> {
    await this.ctx.db.run(
      "UPDATE memory_facts SET sync_errors=sync_errors+1,sync_error=? WHERE instance=? AND id=? " +
        "AND status=? AND changed=?",
      [error, this.ctx.instance, row.id, row.status, row.changed],
    );
  }

  /** Gives every queued fact its attempts back, as a fresh start does. */
  retryAll(): Promise<number> {
    return this.ctx.db.run(
      "UPDATE memory_facts SET sync_errors=0 WHERE instance=? AND indexed=0 AND sync_errors>0",
      [this.ctx.instance],
    );
  }

  /** Marks every current fact for the index again, for an index that starts out empty. */
  reindex(): Promise<number> {
    return this.ctx.db.run(
      "UPDATE memory_facts SET indexed=0 WHERE instance=? AND status='active' AND indexed=1",
      [this.ctx.instance],
    );
  }

  /** The index generation; a new one starts when facts are loaded from another database. */
  async epoch(): Promise<string | null> {
    const rows = await this.ctx.db.query("SELECT epoch FROM memory_index_epochs WHERE instance=?", [
      this.ctx.instance,
    ]);
    return rows[0] ? String(rows[0].epoch) : null;
  }

  /** The newest current fact an outside extractor knows by `external`. */
  async byExternal(external: string, scope: Scope): Promise<number | null> {
    const rows = await this.ctx.db.query(
      "SELECT id FROM memory_facts WHERE instance=? AND external=? AND project=? AND owner=? " +
        "AND status='active' ORDER BY id DESC LIMIT 1",
      [this.ctx.instance, external, scope.project, scope.owner],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  private values(
    scope: Scope,
    kind: string,
    text: string,
    status: FactStatus,
    details: FactDetails,
    replaces: number | null,
    conflict: number | null,
  ): Param[] {
    const now = this.ctx.clock();
    return [
      this.ctx.instance,
      scope.project,
      scope.owner,
      kind,
      text,
      JSON.stringify([...(details.tags ?? [])]),
      details.confidence ?? 1,
      details.quote ?? null,
      details.detail ? JSON.stringify(details.detail) : null,
      details.source,
      PROMPT_VERSION,
      status,
      replaces,
      conflict,
      now,
      now,
      details.external ?? null,
    ];
  }

  /** Moves matching rows to `status` and queues them for the index. */
  private move(status: FactStatus, where: string, params: Param[]): Promise<number> {
    return this.ctx.db.run(
      `UPDATE memory_facts SET status=?,changed=?,indexed=0,sync_errors=0 WHERE ${where}`,
      [status, this.ctx.clock(), ...params],
    );
  }

  private async switch(id: number, scope: Scope, from: FactStatus, to: FactStatus): Promise<void> {
    const moved = await this.move(
      to,
      `instance=? AND id=? AND project=? AND owner=? AND status='${from}'`,
      [this.ctx.instance, id, scope.project, scope.owner],
    );
    if (moved === 0) throw new MemoryError("There is no memory with that number");
  }

  private async mine(id: number, scope: Scope, status: FactStatus): Promise<Fact> {
    const rows = await this.ctx.db.query(
      `SELECT ${FIELDS} FROM memory_facts WHERE instance=? AND id=? AND project=? AND owner=? ` +
        "AND status=?",
      [this.ctx.instance, id, scope.project, scope.owner, status],
    );
    if (!rows[0]) throw new MemoryError("There is no memory with that number");
    return toFact(rows[0]);
  }
}

const COLUMNS =
  "instance,project,owner,kind,text,tags,confidence,quote,detail,source,prompt_version,status," +
  "replaces,conflict,created,changed,external";
