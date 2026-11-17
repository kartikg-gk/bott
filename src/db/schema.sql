CREATE TABLE instances(id TEXT PRIMARY KEY, bot_id INTEGER);
CREATE TABLE poll_state(instance TEXT PRIMARY KEY, offset INTEGER NOT NULL);
CREATE TABLE session_status(
      instance TEXT, session TEXT, data TEXT, PRIMARY KEY(instance,session));
CREATE TABLE conversations(instance TEXT, chat INTEGER, user INTEGER, session TEXT,
          persisted INTEGER DEFAULT 0, thread INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(instance,chat,user,thread));
CREATE TABLE inbox(instance TEXT,id INTEGER,chat INTEGER,user INTEGER,text TEXT,status TEXT,
          run TEXT,created REAL,thread INTEGER NOT NULL DEFAULT 0, route_user INTEGER, version INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(instance,id));
CREATE TABLE approvals(instance TEXT,id TEXT,chat INTEGER,user INTEGER,run TEXT,tool TEXT,
          digest TEXT,created REAL,expires REAL,decision TEXT,source TEXT,
          thread INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(instance,id));
CREATE TABLE session_owners(instance TEXT,session TEXT,chat INTEGER,user INTEGER,title TEXT,
          provider TEXT,model TEXT,thinking TEXT,created REAL,updated REAL,
          thread INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(instance,session));
CREATE TABLE routes(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL,
      chat INTEGER NOT NULL,user INTEGER NOT NULL,thread INTEGER NOT NULL DEFAULT 0,
      session TEXT,session_file TEXT,title TEXT,provider TEXT,model TEXT,thinking TEXT,
      created REAL NOT NULL,updated REAL NOT NULL, bot TEXT,UNIQUE(instance,chat,user,thread));
CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL,
      route INTEGER NOT NULL,direction TEXT NOT NULL,text TEXT,platform_id TEXT,created REAL,
      UNIQUE(instance,direction,platform_id));
CREATE TABLE instance_archive(instance TEXT PRIMARY KEY,archived REAL);
CREATE TABLE imports(instance TEXT,source TEXT,fingerprint TEXT,completed REAL,
      PRIMARY KEY(instance,source));
CREATE TABLE bots(id TEXT PRIMARY KEY,instance TEXT NOT NULL,name TEXT NOT NULL,
          name_key TEXT NOT NULL,role TEXT NOT NULL,instructions TEXT NOT NULL DEFAULT '',
          chief INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL, temporary INTEGER NOT NULL DEFAULT 0,UNIQUE(instance,name_key));
CREATE TABLE route_bots(route INTEGER NOT NULL,bot TEXT NOT NULL,session TEXT,
          session_file TEXT,title TEXT,provider TEXT,model TEXT,thinking TEXT,
          PRIMARY KEY(route,bot));
CREATE TABLE delegations(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL,
          route INTEGER NOT NULL,bot TEXT NOT NULL,task TEXT NOT NULL,status TEXT NOT NULL,
          answer TEXT,created REAL NOT NULL,finished REAL, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL,
          chat INTEGER NOT NULL,user INTEGER NOT NULL,actor INTEGER NOT NULL,
          thread INTEGER NOT NULL,bot TEXT NOT NULL,task TEXT NOT NULL,spec TEXT NOT NULL,
          next_run REAL,missed TEXT NOT NULL DEFAULT 'run',status TEXT NOT NULL DEFAULT 'active',
          running INTEGER NOT NULL DEFAULT 0,last_status TEXT,last_run REAL,created REAL NOT NULL, last_answer TEXT, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE bot_plugins(instance TEXT NOT NULL,bot TEXT NOT NULL,plugin TEXT NOT NULL,
          PRIMARY KEY(instance,bot,plugin));
CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL,
          chat INTEGER NOT NULL,user INTEGER NOT NULL,actor INTEGER NOT NULL,
          thread INTEGER NOT NULL,bot TEXT NOT NULL,goal TEXT NOT NULL,policy TEXT NOT NULL,
          follow_up INTEGER NOT NULL,status TEXT NOT NULL,answer TEXT,reported INTEGER NOT NULL
          DEFAULT 0,created REAL NOT NULL,finished REAL);
CREATE TABLE memory_facts(id INTEGER PRIMARY KEY AUTOINCREMENT,instance TEXT NOT NULL,
          project TEXT NOT NULL,owner INTEGER NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,
          tags TEXT NOT NULL,confidence REAL NOT NULL,quote TEXT,detail TEXT,
          source TEXT NOT NULL,prompt_version INTEGER,status TEXT NOT NULL,replaces INTEGER,
          conflict INTEGER,created REAL NOT NULL,changed REAL NOT NULL,
          indexed INTEGER NOT NULL DEFAULT 0,sync_errors INTEGER NOT NULL DEFAULT 0,
          sync_error TEXT,external TEXT);
CREATE TABLE model_requests(instance TEXT NOT NULL, day TEXT NOT NULL,
                    count INTEGER NOT NULL, PRIMARY KEY(instance, day));
CREATE TABLE bot_profiles(instance TEXT,bot TEXT,style TEXT NOT NULL,
                    voice TEXT NOT NULL,color TEXT NOT NULL,shape TEXT NOT NULL,greeting TEXT,
                    PRIMARY KEY(instance,bot));
CREATE TABLE bot_sessions(instance TEXT,bot TEXT,session_file TEXT,
                    PRIMARY KEY(instance,bot));
CREATE TABLE bot_chat(id INTEGER PRIMARY KEY,instance TEXT NOT NULL,
                    bot TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL);
CREATE TABLE scheduler_leases(instance TEXT PRIMARY KEY, owner TEXT NOT NULL,
                    heartbeat REAL NOT NULL, expires REAL NOT NULL, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE web_bot_routes(instance TEXT NOT NULL, actor INTEGER NOT NULL,
                    bot TEXT NOT NULL, thread INTEGER NOT NULL,
                    PRIMARY KEY(instance,actor,bot), UNIQUE(instance,actor,thread));
CREATE TABLE web_runs(instance TEXT NOT NULL, id TEXT NOT NULL,
                    inbox INTEGER NOT NULL, bot TEXT NOT NULL, actor INTEGER NOT NULL,
                    answer TEXT, finished REAL, version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(instance,id), UNIQUE(instance,inbox));
CREATE TABLE web_run_events(instance TEXT NOT NULL, run TEXT NOT NULL,
                    seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
                    PRIMARY KEY(instance,run,seq),
                    FOREIGN KEY(instance,run) REFERENCES web_runs(instance,id) ON DELETE CASCADE);
CREATE TABLE memory_index_epochs(instance TEXT PRIMARY KEY, epoch TEXT NOT NULL);
CREATE TABLE job_automation(instance TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
CREATE TABLE job_event_receipts(instance TEXT NOT NULL, actor INTEGER NOT NULL,
                    event TEXT NOT NULL, delivery TEXT NOT NULL, received REAL NOT NULL,
                    PRIMARY KEY(instance,actor,event,delivery));
CREATE TABLE job_wakeups(id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instance TEXT NOT NULL, actor INTEGER NOT NULL, job INTEGER NOT NULL,
                    event TEXT NOT NULL,
                    delivery TEXT NOT NULL, received REAL NOT NULL, claimed REAL, finished REAL,
                    status TEXT NOT NULL DEFAULT 'queued');
CREATE TABLE model_spend(instance TEXT NOT NULL, day TEXT NOT NULL,
                    micros INTEGER NOT NULL, PRIMARY KEY(instance,day));
CREATE TABLE bot_memory(instance TEXT NOT NULL, bot TEXT NOT NULL, file TEXT NOT NULL, content TEXT NOT NULL, updated REAL NOT NULL, PRIMARY KEY(instance,bot,file));
CREATE TABLE skill_files(instance TEXT NOT NULL, scope TEXT NOT NULL, skill TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(instance,scope,skill,path));
CREATE TABLE leases(name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE run_context(instance TEXT NOT NULL, inbox INTEGER NOT NULL, conversation TEXT NOT NULL, PRIMARY KEY(instance,inbox));
CREATE INDEX inbox_pending ON inbox(instance,status,id);
CREATE INDEX routes_sessions ON routes(instance,session_file);
CREATE UNIQUE INDEX one_chief ON bots(instance) WHERE chief=1;
CREATE UNIQUE INDEX one_task_per_bot ON delegations(instance,bot)
          WHERE status='running';
CREATE INDEX jobs_due ON jobs(instance,status,next_run);
CREATE INDEX tasks_status ON tasks(instance,status);
CREATE INDEX memory_owner ON memory_facts(instance,project,owner,status);
CREATE INDEX memory_unsynced ON memory_facts(instance,indexed);
CREATE INDEX jobs_actor ON jobs(instance,actor,status);
CREATE INDEX web_runs_active ON web_runs(instance,actor,finished);
CREATE INDEX job_wakeup_queue ON job_wakeups(instance,job,status,id);
CREATE TRIGGER cancel_queued_wakeups AFTER UPDATE OF status,spec ON jobs
                WHEN NEW.status='cancelled' OR NEW.spec<>OLD.spec BEGIN
                    UPDATE job_wakeups SET status='cancelled',finished=unixepoch()
                    WHERE instance=NEW.instance AND job=NEW.id AND status='queued';
                END;
