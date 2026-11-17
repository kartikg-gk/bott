import type { Database } from "./database.js";
import type { SqliteDatabase } from "./sqlite.js";

/** What a step may ask about the database it is about to change. */
export interface FileFacts {
  tables(): Promise<Set<string>>;
  columns(table: string): Promise<Set<string>>;
}

/**
 * One schema step. Its statements are worked out from what the database holds when the step
 * starts, and each is skipped once done, so a step cut off part way does only what is left
 * when run again. A local file takes each step in one transaction and records `reaches` in
 * `user_version`; a hosted database, which has no transactions across requests, runs the
 * statements one at a time and is marked only once every step is done.
 */
export interface Upgrade {
  reaches: number;
  /** The lowest version this step accepts; the version just below `reaches` unless set. */
  lowest?: number;
  statements(file: FileFacts): string[] | Promise<string[]>;
}

/** Adds a column, unless the table already has it. */
async function addColumn(
  file: FileFacts,
  table: string,
  column: string,
  definition: string,
): Promise<string[]> {
  if ((await file.columns(table)).has(column)) return [];
  return [`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`];
}

/**
 * Up to schema 2 a person had one conversation per chat. Threads came with 3: the
 * conversations table is rebuilt with a thread in its key, and the tables that point at a
 * conversation gain a thread column. Everything from before lands in thread 0.
 */
async function addThreads(file: FileFacts): Promise<string[]> {
  const tables = await file.tables();
  // The old table is set aside under this name while the new one is filled.
  const parked = tables.has("conversations_without_threads");
  const threadless =
    tables.has("conversations") && !(await file.columns("conversations")).has("thread");
  const rebuild: string[] = [];
  if (threadless && !parked) {
    rebuild.push("ALTER TABLE conversations RENAME TO conversations_without_threads");
  }
  if (threadless || parked) {
    rebuild.push(
      "CREATE TABLE IF NOT EXISTS conversations(instance TEXT,chat INTEGER,user INTEGER," +
        "session TEXT,persisted INTEGER DEFAULT 0,thread INTEGER NOT NULL DEFAULT 0," +
        "PRIMARY KEY(instance,chat,user,thread))",
      "INSERT OR IGNORE INTO conversations(instance,chat,user,session,persisted,thread) " +
        "SELECT instance,chat,user,session,persisted,0 FROM conversations_without_threads",
      "DROP TABLE conversations_without_threads",
    );
  }
  const threads: string[] = [];
  for (const table of ["inbox", "approvals", "session_owners"]) {
    threads.push(...(await addColumn(file, table, "thread", "INTEGER NOT NULL DEFAULT 0")));
  }
  return [
    "CREATE TABLE IF NOT EXISTS session_owners(instance TEXT,session TEXT,chat INTEGER," +
      "user INTEGER,title TEXT,provider TEXT,model TEXT,thinking TEXT,created REAL,updated REAL," +
      "PRIMARY KEY(instance,session))",
    ...rebuild,
    ...threads,
  ];
}

/**
 * Schema 4 put each chat's state in one routes table, with its messages, and remembered who
 * owns each session. A file at 1, 2 or 3 reaches it in one step.
 */
const routes: Upgrade = {
  reaches: 4,
  lowest: 1,
  statements: async (file) => [
    "CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY, bot_id INTEGER)",
    "CREATE TABLE IF NOT EXISTS poll_state(instance TEXT PRIMARY KEY, offset INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS session_status(instance TEXT, session TEXT, data TEXT, " +
      "PRIMARY KEY(instance,session))",
    ...(await addThreads(file)),
    // Every conversation with a session already belongs to its chat and person.
    "INSERT OR IGNORE INTO session_owners(instance,session,chat,user,thread,created,updated) " +
      "SELECT instance,session,chat,user,thread,0,0 FROM conversations WHERE session IS NOT NULL",
    ...(await addColumn(file, "inbox", "route_user", "INTEGER")),
    "UPDATE inbox SET route_user=user WHERE route_user IS NULL",
    "CREATE TABLE IF NOT EXISTS routes(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL," +
      "chat INTEGER NOT NULL,user INTEGER NOT NULL,thread INTEGER NOT NULL DEFAULT 0," +
      "session TEXT,session_file TEXT,title TEXT,provider TEXT,model TEXT,thinking TEXT," +
      "created REAL NOT NULL,updated REAL NOT NULL,UNIQUE(instance,chat,user,thread))",
    "CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL," +
      "route INTEGER NOT NULL,direction TEXT NOT NULL,text TEXT,platform_id TEXT,created REAL," +
      "UNIQUE(instance,direction,platform_id))",
    "CREATE TABLE IF NOT EXISTS instance_archive(instance TEXT PRIMARY KEY,archived REAL)",
    "CREATE TABLE IF NOT EXISTS imports(instance TEXT,source TEXT,fingerprint TEXT,completed REAL," +
      "PRIMARY KEY(instance,source))",
    "CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(instance,status,id)",
    "CREATE INDEX IF NOT EXISTS routes_sessions ON routes(instance,session_file)",
  ],
};

/**
 * Named bots, one of them the chief, and each route's chosen bot with its own session per bot.
 * Routes from before this step have no bot yet; the store gives them the chief when opened.
 */
const namedBots: Upgrade = {
  reaches: 5,
  statements: async (file) => [
    "CREATE TABLE IF NOT EXISTS bots(id TEXT PRIMARY KEY,instance TEXT NOT NULL,name TEXT NOT NULL," +
      "name_key TEXT NOT NULL,role TEXT NOT NULL,instructions TEXT NOT NULL DEFAULT ''," +
      "chief INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL,UNIQUE(instance,name_key))",
    "CREATE UNIQUE INDEX IF NOT EXISTS one_chief ON bots(instance) WHERE chief=1",
    ...(await addColumn(file, "routes", "bot", "TEXT")),
    "CREATE TABLE IF NOT EXISTS route_bots(route INTEGER NOT NULL,bot TEXT NOT NULL,session TEXT," +
      "session_file TEXT,title TEXT,provider TEXT,model TEXT,thinking TEXT," +
      "PRIMARY KEY(route,bot))",
  ],
};

/** Work the chief hands to another bot. A bot runs at most one such task at a time. */
const delegations: Upgrade = {
  reaches: 6,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS delegations(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL," +
      "route INTEGER NOT NULL,bot TEXT NOT NULL,task TEXT NOT NULL,status TEXT NOT NULL," +
      "answer TEXT,created REAL NOT NULL,finished REAL)",
    "CREATE UNIQUE INDEX IF NOT EXISTS one_task_per_bot ON delegations(instance,bot) WHERE status='running'",
  ],
};

/** Scheduled jobs, and the lookup that finds the ones due. */
const scheduledJobs: Upgrade = {
  reaches: 7,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL," +
      "chat INTEGER NOT NULL,user INTEGER NOT NULL,actor INTEGER NOT NULL," +
      "thread INTEGER NOT NULL,bot TEXT NOT NULL,task TEXT NOT NULL,spec TEXT NOT NULL," +
      "next_run REAL,missed TEXT NOT NULL DEFAULT 'run',status TEXT NOT NULL DEFAULT 'active'," +
      "running INTEGER NOT NULL DEFAULT 0,last_status TEXT,last_run REAL,created REAL NOT NULL)",
    "CREATE INDEX IF NOT EXISTS jobs_due ON jobs(instance,status,next_run)",
  ],
};

/** The apps each bot has been granted. */
const appGrants: Upgrade = {
  reaches: 8,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS bot_plugins(instance TEXT NOT NULL,bot TEXT NOT NULL,plugin TEXT NOT NULL," +
      "PRIMARY KEY(instance,bot,plugin))",
  ],
};

/** Background agents: their tasks, and temporary bots that exist only while one runs. */
const backgroundTasks: Upgrade = {
  reaches: 9,
  statements: async (file) => [
    ...(await addColumn(file, "bots", "temporary", "INTEGER NOT NULL DEFAULT 0")),
    "CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL," +
      "chat INTEGER NOT NULL,user INTEGER NOT NULL,actor INTEGER NOT NULL," +
      "thread INTEGER NOT NULL,bot TEXT NOT NULL,goal TEXT NOT NULL,policy TEXT NOT NULL," +
      "follow_up INTEGER NOT NULL,status TEXT NOT NULL,answer TEXT," +
      "reported INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL,finished REAL)",
    "CREATE INDEX IF NOT EXISTS tasks_status ON tasks(instance,status)",
  ],
};

/** Long-term facts, with their revisions, conflicts and index state. */
const memoryFacts: Upgrade = {
  reaches: 10,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS memory_facts(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL," +
      "project TEXT NOT NULL,owner INTEGER NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL," +
      "tags TEXT NOT NULL,confidence REAL NOT NULL,quote TEXT,detail TEXT," +
      "source TEXT NOT NULL,prompt_version INTEGER,status TEXT NOT NULL,replaces INTEGER," +
      "conflict INTEGER,created REAL NOT NULL,changed REAL NOT NULL," +
      "indexed INTEGER NOT NULL DEFAULT 0,sync_errors INTEGER NOT NULL DEFAULT 0," +
      "sync_error TEXT,external TEXT)",
    "CREATE INDEX IF NOT EXISTS memory_owner ON memory_facts(instance,project,owner,status)",
    "CREATE INDEX IF NOT EXISTS memory_unsynced ON memory_facts(instance,indexed)",
  ],
};

/** How many model requests each instance made per day. */
const requestCounts: Upgrade = {
  reaches: 11,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS model_requests(instance TEXT NOT NULL, day TEXT NOT NULL, " +
      "count INTEGER NOT NULL, PRIMARY KEY(instance, day))",
  ],
};

/** A bot's look and greeting, the session it is on, and its chat with the person. */
const botProfiles: Upgrade = {
  reaches: 12,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS bot_profiles(instance TEXT,bot TEXT,style TEXT NOT NULL,voice TEXT NOT NULL," +
      "color TEXT NOT NULL,shape TEXT NOT NULL,greeting TEXT,PRIMARY KEY(instance,bot))",
    "CREATE TABLE IF NOT EXISTS bot_sessions(instance TEXT,bot TEXT,session_file TEXT,PRIMARY KEY(instance,bot))",
    "CREATE TABLE IF NOT EXISTS bot_chat(id INTEGER PRIMARY KEY,instance TEXT NOT NULL,bot TEXT NOT NULL," +
      "role TEXT NOT NULL,text TEXT NOT NULL)",
  ],
};

/** A job's last answer, a lookup of jobs by person, and the lease the scheduler holds. */
const schedulerLease: Upgrade = {
  reaches: 13,
  statements: async (file) => [
    ...(await addColumn(file, "jobs", "last_answer", "TEXT")),
    "CREATE INDEX IF NOT EXISTS jobs_actor ON jobs(instance,actor,status)",
    "CREATE TABLE IF NOT EXISTS scheduler_leases(instance TEXT PRIMARY KEY, owner TEXT NOT NULL, " +
      "heartbeat REAL NOT NULL, expires REAL NOT NULL)",
  ],
};

/** The web page's thread per bot, and the journal of each run the page starts. */
const webRuns: Upgrade = {
  reaches: 14,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS web_bot_routes(instance TEXT NOT NULL, actor INTEGER NOT NULL, " +
      "bot TEXT NOT NULL, thread INTEGER NOT NULL, " +
      "PRIMARY KEY(instance,actor,bot), UNIQUE(instance,actor,thread))",
    "CREATE TABLE IF NOT EXISTS web_runs(instance TEXT NOT NULL, id TEXT NOT NULL, inbox INTEGER NOT NULL, " +
      "bot TEXT NOT NULL, actor INTEGER NOT NULL, answer TEXT, finished REAL, " +
      "PRIMARY KEY(instance,id), UNIQUE(instance,inbox))",
    "CREATE INDEX IF NOT EXISTS web_runs_active ON web_runs(instance,actor,finished)",
    "CREATE TABLE IF NOT EXISTS web_run_events(instance TEXT NOT NULL, run TEXT NOT NULL, " +
      "seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, " +
      "PRIMARY KEY(instance,run,seq), " +
      "FOREIGN KEY(instance,run) REFERENCES web_runs(instance,id) ON DELETE CASCADE)",
  ],
};

/** Which copy of the memory index belongs to the instance. */
const indexEpochs: Upgrade = {
  reaches: 15,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS memory_index_epochs(instance TEXT PRIMARY KEY, epoch TEXT NOT NULL)",
  ],
};

/** Jobs woken by named events: the switch, each delivery seen, and the queue of wake-ups. */
const eventWakeups: Upgrade = {
  reaches: 16,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS job_automation(instance TEXT PRIMARY KEY, enabled INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS job_event_receipts(instance TEXT NOT NULL, actor INTEGER NOT NULL, " +
      "event TEXT NOT NULL, delivery TEXT NOT NULL, received REAL NOT NULL, " +
      "PRIMARY KEY(instance,actor,event,delivery))",
    "CREATE TABLE IF NOT EXISTS job_wakeups(id INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL, " +
      "actor INTEGER NOT NULL, job INTEGER NOT NULL, event TEXT NOT NULL, " +
      "delivery TEXT NOT NULL, received REAL NOT NULL, claimed REAL, finished REAL, " +
      "status TEXT NOT NULL DEFAULT 'queued')",
    "CREATE INDEX IF NOT EXISTS job_wakeup_queue ON job_wakeups(instance,job,status,id)",
    // A job that is cancelled or rescheduled drops the wake-ups still waiting for it.
    "CREATE TRIGGER IF NOT EXISTS cancel_queued_wakeups AFTER UPDATE OF status,spec ON jobs " +
      "WHEN NEW.status='cancelled' OR NEW.spec<>OLD.spec BEGIN " +
      "UPDATE job_wakeups SET status='cancelled',finished=unixepoch() " +
      "WHERE instance=NEW.instance AND job=NEW.id AND status='queued'; END",
  ],
};

/** What each instance spent on models per day, in millionths of a dollar. */
const spendCounts: Upgrade = {
  reaches: 17,
  statements: () => [
    "CREATE TABLE IF NOT EXISTS model_spend(instance TEXT NOT NULL, day TEXT NOT NULL, " +
      "micros INTEGER NOT NULL, PRIMARY KEY(instance,day))",
  ],
};

/** Tables whose rows count their writes, so an update only lands on the version it read. */
const COUNTED = ["jobs", "web_runs", "approvals", "inbox", "delegations", "scheduler_leases"];

/** A write counter on each shared row. A table that already has one is left as it is. */
const writeCounters: Upgrade = {
  reaches: 18,
  async statements(file) {
    const added: string[] = [];
    for (const table of COUNTED) {
      added.push(...(await addColumn(file, table, "version", "INTEGER NOT NULL DEFAULT 0")));
    }
    return added;
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
  routes,
  namedBots,
  delegations,
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

/** Reads tables and columns through the database's own interface, on either backend. */
function factsOf(db: Database): FileFacts {
  return {
    async tables() {
      const rows = await db.query("SELECT name FROM sqlite_master WHERE type='table'");
      return new Set(rows.map((row) => String(row.name)));
    },
    async columns(table) {
      const rows = await db.query(`SELECT name FROM pragma_table_info('${table}')`);
      return new Set(rows.map((row) => String(row.name)));
    },
  };
}

async function fileVersion(file: SqliteDatabase): Promise<number> {
  return Number((await file.query("PRAGMA user_version"))[0]?.user_version ?? 0);
}

/**
 * Applies every step the file has not had yet, one transaction per step. Each step reads the
 * version again once it holds the write lock: another process opening the same file may have
 * taken the step meanwhile, and then it is passed over instead of applied twice.
 */
export async function applyUpgrades(file: SqliteDatabase, from: number): Promise<void> {
  const facts = factsOf(file);
  for (const step of UPGRADES) {
    if (from >= step.reaches) continue;
    await file.locked(async () => {
      if ((await fileVersion(file)) >= step.reaches) return;
      for (const statement of await step.statements(facts)) await file.run(statement);
      await file.run(`PRAGMA user_version = ${step.reaches}`);
    });
  }
}

/**
 * Applies every step a hosted database at `from` has not had, one statement per request.
 * Nothing groups the requests, so each statement is one that is skipped once done (see
 * `Upgrade`), and a run that stops part way is finished by the next. A change another process
 * starting at the same moment has just made counts as done.
 */
export async function applyHostedUpgrades(db: Database, from: number): Promise<void> {
  const facts = factsOf(db);
  for (const step of UPGRADES) {
    if (from >= step.reaches) continue;
    for (const statement of await step.statements(facts)) {
      try {
        await db.run(statement);
      } catch (error) {
        if (!/already exists|duplicate column name/i.test((error as Error).message)) throw error;
      }
    }
  }
}
