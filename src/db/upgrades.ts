import type { SqliteDatabase } from "./sqlite.js";

/** What a step may ask about the file it is about to change. */
export interface FileFacts {
  /** The schema version the file had when it was opened. */
  from: number;
  columns(table: string): Promise<Set<string>>;
}

/** One schema step. Each runs in its own transaction and sets `user_version` to `reaches`. */
export interface Upgrade {
  reaches: number;
  /** The lowest version this step accepts; the version just below `reaches` unless set. */
  lowest?: number;
  statements(file: FileFacts): string[] | Promise<string[]>;
}

/** Scheduled jobs, and the lookup that finds the ones due. */
const scheduledJobs: Upgrade = {
  reaches: 7,
  statements: () => [
    "CREATE TABLE jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL," +
      "chat INTEGER NOT NULL,user INTEGER NOT NULL,actor INTEGER NOT NULL," +
      "thread INTEGER NOT NULL,bot TEXT NOT NULL,task TEXT NOT NULL,spec TEXT NOT NULL," +
      "next_run REAL,missed TEXT NOT NULL DEFAULT 'run',status TEXT NOT NULL DEFAULT 'active'," +
      "running INTEGER NOT NULL DEFAULT 0,last_status TEXT,last_run REAL,created REAL NOT NULL)",
    "CREATE INDEX jobs_due ON jobs(instance,status,next_run)",
  ],
};

/** The apps each bot has been granted. */
const appGrants: Upgrade = {
  reaches: 8,
  statements: () => [
    "CREATE TABLE bot_plugins(instance TEXT NOT NULL,bot TEXT NOT NULL,plugin TEXT NOT NULL," +
      "PRIMARY KEY(instance,bot,plugin))",
  ],
};

/** Background agents: their tasks, and temporary bots that exist only while one runs. */
const backgroundTasks: Upgrade = {
  reaches: 9,
  statements: () => [
    "ALTER TABLE bots ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0",
    "CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL," +
      "chat INTEGER NOT NULL,user INTEGER NOT NULL,actor INTEGER NOT NULL," +
      "thread INTEGER NOT NULL,bot TEXT NOT NULL,goal TEXT NOT NULL,policy TEXT NOT NULL," +
      "follow_up INTEGER NOT NULL,status TEXT NOT NULL,answer TEXT," +
      "reported INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL,finished REAL)",
    "CREATE INDEX tasks_status ON tasks(instance,status)",
  ],
};

/** Long-term facts, with their revisions, conflicts and index state. */
const memoryFacts: Upgrade = {
  reaches: 10,
  statements: () => [
    "CREATE TABLE memory_facts(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL," +
      "project TEXT NOT NULL,owner INTEGER NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL," +
      "tags TEXT NOT NULL,confidence REAL NOT NULL,quote TEXT,detail TEXT," +
      "source TEXT NOT NULL,prompt_version INTEGER,status TEXT NOT NULL,replaces INTEGER," +
      "conflict INTEGER,created REAL NOT NULL,changed REAL NOT NULL," +
      "indexed INTEGER NOT NULL DEFAULT 0,sync_errors INTEGER NOT NULL DEFAULT 0," +
      "sync_error TEXT,external TEXT)",
    "CREATE INDEX memory_owner ON memory_facts(instance,project,owner,status)",
    "CREATE INDEX memory_unsynced ON memory_facts(instance,indexed)",
  ],
};

/** How many model requests each instance made per day. */
const requestCounts: Upgrade = {
  reaches: 11,
  statements: () => [
    "CREATE TABLE model_requests(instance TEXT NOT NULL, day TEXT NOT NULL, " +
      "count INTEGER NOT NULL, PRIMARY KEY(instance, day))",
  ],
};

/** A bot's look and greeting, the session it is on, and its chat with the person. */
const botProfiles: Upgrade = {
  reaches: 12,
  statements: () => [
    "CREATE TABLE bot_profiles(instance TEXT,bot TEXT,style TEXT NOT NULL,voice TEXT NOT NULL," +
      "color TEXT NOT NULL,shape TEXT NOT NULL,greeting TEXT,PRIMARY KEY(instance,bot))",
    "CREATE TABLE bot_sessions(instance TEXT,bot TEXT,session_file TEXT,PRIMARY KEY(instance,bot))",
    "CREATE TABLE bot_chat(id INTEGER PRIMARY KEY,instance TEXT NOT NULL,bot TEXT NOT NULL," +
      "role TEXT NOT NULL,text TEXT NOT NULL)",
  ],
};

/** A job's last answer, a lookup of jobs by person, and the lease the scheduler holds. */
const schedulerLease: Upgrade = {
  reaches: 13,
  statements: () => [
    "ALTER TABLE jobs ADD COLUMN last_answer TEXT",
    "CREATE INDEX jobs_actor ON jobs(instance,actor,status)",
    "CREATE TABLE scheduler_leases(instance TEXT PRIMARY KEY, owner TEXT NOT NULL, " +
      "heartbeat REAL NOT NULL, expires REAL NOT NULL)",
  ],
};

/** The web page's thread per bot, and the journal of each run the page starts. */
const webRuns: Upgrade = {
  reaches: 14,
  statements: () => [
    "CREATE TABLE web_bot_routes(instance TEXT NOT NULL, actor INTEGER NOT NULL, " +
      "bot TEXT NOT NULL, thread INTEGER NOT NULL, " +
      "PRIMARY KEY(instance,actor,bot), UNIQUE(instance,actor,thread))",
    "CREATE TABLE web_runs(instance TEXT NOT NULL, id TEXT NOT NULL, inbox INTEGER NOT NULL, " +
      "bot TEXT NOT NULL, actor INTEGER NOT NULL, answer TEXT, finished REAL, " +
      "PRIMARY KEY(instance,id), UNIQUE(instance,inbox))",
    "CREATE INDEX web_runs_active ON web_runs(instance,actor,finished)",
    "CREATE TABLE web_run_events(instance TEXT NOT NULL, run TEXT NOT NULL, " +
      "seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, " +
      "PRIMARY KEY(instance,run,seq), " +
      "FOREIGN KEY(instance,run) REFERENCES web_runs(instance,id) ON DELETE CASCADE)",
  ],
};

/** Which copy of the memory index belongs to the instance. */
const indexEpochs: Upgrade = {
  reaches: 15,
  statements: () => [
    "CREATE TABLE memory_index_epochs(instance TEXT PRIMARY KEY, epoch TEXT NOT NULL)",
  ],
};

/** Jobs woken by named events: the switch, each delivery seen, and the queue of wake-ups. */
const eventWakeups: Upgrade = {
  reaches: 16,
  statements: () => [
    "CREATE TABLE job_automation(instance TEXT PRIMARY KEY, enabled INTEGER NOT NULL)",
    "CREATE TABLE job_event_receipts(instance TEXT NOT NULL, actor INTEGER NOT NULL, " +
      "event TEXT NOT NULL, delivery TEXT NOT NULL, received REAL NOT NULL, " +
      "PRIMARY KEY(instance,actor,event,delivery))",
    "CREATE TABLE job_wakeups(id INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL, " +
      "actor INTEGER NOT NULL, job INTEGER NOT NULL, event TEXT NOT NULL, " +
      "delivery TEXT NOT NULL, received REAL NOT NULL, claimed REAL, finished REAL, " +
      "status TEXT NOT NULL DEFAULT 'queued')",
    "CREATE INDEX job_wakeup_queue ON job_wakeups(instance,job,status,id)",
    // A job that is cancelled or rescheduled drops the wake-ups still waiting for it.
    "CREATE TRIGGER cancel_queued_wakeups AFTER UPDATE OF status,spec ON jobs " +
      "WHEN NEW.status='cancelled' OR NEW.spec<>OLD.spec BEGIN " +
      "UPDATE job_wakeups SET status='cancelled',finished=unixepoch() " +
      "WHERE instance=NEW.instance AND job=NEW.id AND status='queued'; END",
  ],
};

/** What each instance spent on models per day, in millionths of a dollar. */
const spendCounts: Upgrade = {
  reaches: 17,
  statements: () => [
    "CREATE TABLE model_spend(instance TEXT NOT NULL, day TEXT NOT NULL, " +
      "micros INTEGER NOT NULL, PRIMARY KEY(instance,day))",
  ],
};

/** Tables whose rows count their writes, so an update only lands on the version it read. */
const COUNTED = ["jobs", "web_runs", "approvals", "inbox", "delegations", "scheduler_leases"];

/** A write counter on each shared row. A table that already has one is left as it is. */
const writeCounters: Upgrade = {
  reaches: 18,
  async statements(file) {
    const missing: string[] = [];
    for (const table of COUNTED) {
      if (!(await file.columns(table)).has("version")) missing.push(table);
    }
    return missing.map(
      (table) => `ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 0`,
    );
  },
};

/** Notes and skill files for hosted bots, whose folders do not outlast a request. */
const hostedFiles: Upgrade = {
  reaches: 19,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS bot_memory(instance TEXT NOT NULL, bot TEXT NOT NULL, " +
      "file TEXT NOT NULL, content TEXT NOT NULL, updated REAL NOT NULL, " +
      "PRIMARY KEY(instance,bot,file))",
    "CREATE TABLE IF NOT EXISTS skill_files(instance TEXT NOT NULL, scope TEXT NOT NULL, " +
      "skill TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, revision TEXT NOT NULL, " +
      "PRIMARY KEY(instance,scope,skill,path))",
  ],
};

/** Named leases that stand in for file locks when several processes share one database. */
const leases: Upgrade = {
  reaches: 20,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY, owner TEXT NOT NULL, " +
      "expires REAL NOT NULL)",
  ],
};

/** Earlier messages a browser sent along with a hosted run, held until the run starts. */
const runContext: Upgrade = {
  reaches: 21,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS run_context(instance TEXT NOT NULL, inbox INTEGER NOT NULL, " +
      "conversation TEXT NOT NULL, PRIMARY KEY(instance,inbox))",
  ],
};

/** Every step, oldest first. The last one reaches the schema this build writes. */
export const UPGRADES: readonly Upgrade[] = [
  scheduledJobs,
  appGrants,
  backgroundTasks,
  memoryFacts,
  requestCounts,
  botProfiles,
  schedulerLease,
  webRuns,
  indexEpochs,
  eventWakeups,
  spendCounts,
  writeCounters,
  hostedFiles,
  leases,
  runContext,
];

/** The oldest schema version a file can be at and still be brought up to date here. */
export function oldestUpgradable(): number {
  const first = UPGRADES[0] as Upgrade;
  return first.lowest ?? first.reaches - 1;
}

/** Applies every step the file has not had yet, one transaction per step. */
export async function applyUpgrades(file: SqliteDatabase, from: number): Promise<void> {
  const facts: FileFacts = {
    from,
    async columns(table) {
      const rows = await file.query(`SELECT name FROM pragma_table_info('${table}')`);
      return new Set(rows.map((row) => String(row.name)));
    },
  };
  for (const step of UPGRADES) {
    if (from >= step.reaches) continue;
    const body = (await step.statements(facts)).map((statement) => `${statement};\n`).join("");
    await file.script(`${body}PRAGMA user_version = ${step.reaches};`);
  }
}
