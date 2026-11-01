import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { buildSystem } from "../agent/instructions.ts";
import type { Policy } from "../agent/policy.ts";
import type { ModelProvider } from "../agent/providers/types.ts";
import {
  AgentSession,
  type HostToolCall,
  type Outcome,
  type SessionEvent,
  type SessionState,
} from "../agent/session.ts";
import { jsonlSessionStore, memorySessionStore, type SessionStore } from "../agent/sessionStore.ts";
import { loadSkills, type Skill } from "../agent/skills.ts";
import { fileTools } from "../agent/tools/files.ts";
import { shellTool } from "../agent/tools/shell.ts";
import type { Workspace } from "../agent/tools/workspace.ts";
import type { ToolSpec } from "../agent/tools.ts";
import { textOf } from "../agent/transcript.ts";
import { type Bot, botRoot, MEMORY_FILES, systemAddition, workspaceDir } from "../bots/bots.ts";
import {
  type Profile,
  profile,
  recordChat,
  rememberSession,
  STYLES,
  savedSession,
} from "../bots/profiles.ts";
import { type ComputerFactory, makeComputer } from "../computers/index.ts";
import { type ComputerSettings, computerSettings } from "../computers/settings.ts";
import { Lease } from "../db/leases.ts";
import type { Route } from "../store/routes.ts";
import type { Store } from "../store/store.ts";
import { type Agents, answerTeamCall, jobTools, teamTools } from "./team.ts";

export interface RuntimeConfig {
  stateDir: string;
  projectDir: string;
  /** Where session files go; null keeps transcripts in memory (hosted). */
  sessionsDir: string | null;
  policy: Policy;
  model: string;
  idleSeconds: number;
  /** How long an approval waits for an answer before it is denied; 300 when not given. */
  approvalSeconds?: number;
  /** Where bots' commands run; this machine when left out. */
  computer?: ComputerSettings;
}

/** Makes the model provider a bot's session talks to. */
export type ProviderFactory = (bot: Bot, profile: Profile) => ModelProvider;

/** The session an event came from and the bot it runs, so an answer can reach it. */
export interface EventSource {
  session: AgentSession;
  bot: string;
}

export type EventObserver = (event: SessionEvent, source: EventSource) => void;

export interface PromptOptions {
  onEvent?: EventObserver | undefined;
}

/** Who started a piece of work: the conversation it belongs to and the person who asked. */
export interface Origin {
  route: Route;
  actor: number;
}

/** Takes the approval events of work started from a conversation, such as a delegation. */
export type ApprovalRelay = (origin: Origin, event: SessionEvent, source: EventSource) => void;

export interface Answer {
  text: string;
  outcome: Outcome;
}

/** What a route's conversation looks like, whether or not its session is loaded. */
export interface RouteState {
  sessionId: string | null;
  sessionFile: string | null;
  model: { provider: string | null; id: string | null };
  isStreaming: boolean;
  messageCount?: number;
}

/** A delegated run that did not complete; the answer holds whatever it said or the error. */
export class RunFailed extends Error {
  constructor(
    readonly outcome: Outcome,
    readonly answer: string,
  ) {
    super(answer || `The run ended ${outcome}.`);
  }
}

/** The bot is running a prompt or delegation here or in another process. */
export class BotBusy extends Error {
  constructor() {
    super("This bot is busy; wait until it is done.");
  }
}

/** How long a bot's database hold lasts without renewal; it is renewed well before then. */
const BOT_LEASE_SECONDS = 60;

const BASE =
  "You are an assistant working for the person in this conversation. Use your tools to read " +
  "and change files and run commands in your workspace. Be accurate, and say what you did.";

const SWEEP_SECONDS = 60;

/** Waiters run in arrival order; `acquire` resolves with the release function. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = this.tail;
    this.tail = before.then(() => held);
    await before;
    return release;
  }
}

interface Built {
  system: string;
  tools: ToolSpec[];
  skills: Skill[];
  profile: Profile;
  /** Changes whenever anything the session was built from changes. */
  signature: string;
}

/** A loaded session and the one reader that takes its events. */
class Live {
  listener: ((event: SessionEvent) => void) | undefined;
  busy = false;

  constructor(
    readonly session: AgentSession,
    readonly botId: string,
    readonly signature: string,
    readonly sessionFile: string | null,
    public touched: number,
  ) {
    void this.pump();
  }

  private async pump(): Promise<void> {
    for await (const event of this.session.events()) this.listener?.(event);
  }
}

const routeKey = (id: number) => `route:${id}`;
const sessionKey = (id: string) => `session:${id}`;
/** The lock a route runs under: its session, or its file's session when only the file is known. */
const keyOf = (route: Route) => {
  if (route.session) return sessionKey(route.session);
  if (route.sessionFile) return sessionKey(basename(route.sessionFile, ".jsonl"));
  return routeKey(route.id);
};

/** Keeps one agent session per conversation and runs its prompts one at a time. */
export class SessionManager {
  private readonly live = new Map<string, Live>();
  private readonly delegations = new Set<Live>();
  private readonly locks = new Map<string, Mutex>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly creating = new Mutex();
  /** Bots running a prompt or delegation in this process. */
  private readonly activeBots = new Set<string>();
  /** Hosted transcripts, kept for as long as this manager lives. */
  private readonly memory = memorySessionStore();
  private readonly timer: NodeJS.Timeout;
  /** Background work the chief's cancel_task can stop; set by whatever runs it. */
  agents: Agents | undefined;
  /** Where approvals asked by delegations and background agents go; set by whatever shows them. */
  approvals: ApprovalRelay | undefined;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: Store,
    private readonly providers: ProviderFactory,
    private readonly computers: ComputerFactory = makeComputer,
  ) {
    const every = Math.max(1, Math.min(config.idleSeconds, SWEEP_SECONDS));
    this.timer = setInterval(() => this.sweep(), every * 1000);
    this.timer.unref();
  }

  /** Where a bot's files live and its commands run: one computer per bot, kept between runs. */
  workspaceFor(bot: Pick<Bot, "id" | "chief">): Workspace {
    let found = this.workspaces.get(bot.id);
    if (!found) {
      found = this.computers(this.settings, {
        instance: this.store.ctx.instance,
        bot,
        hostRoot: workspaceDir(this.config.stateDir, this.config.projectDir, bot),
        memoryDir: join(botRoot(this.config.stateDir, bot), "memory"),
      });
      this.workspaces.set(bot.id, found);
    }
    return found;
  }

  /** Whether bots work on sandboxed computers: containers and sandboxes are, this machine is not. */
  get sandboxed(): boolean {
    return this.settings.executor !== "local";
  }

  private get settings(): ComputerSettings {
    return this.config.computer ?? computerSettings({});
  }

  /** Deletes the bot's computer, once nothing is running on the bot. */
  async removeComputer(bot: Pick<Bot, "id" | "chief">): Promise<void> {
    const release = await this.holdBot(bot.id, false);
    try {
      await this.dropComputer(bot);
    } finally {
      await release();
    }
  }

  /**
   * Removes a temporary bot with its computer, rows and folder. Kept bots and the chief are
   * refused before anything is touched. Returns false when the bot is already gone.
   */
  async removeBot(id: string): Promise<boolean> {
    const found = await this.store.bot(id);
    if (!found) return false;
    if (found.chief) throw new Error("The chief of staff cannot be removed");
    if (!found.temporary) throw new Error("Only a temporary bot can be removed");
    const release = await this.holdBot(id, false);
    try {
      await this.dropComputer(found);
      const removed = await this.store.removeBot(id);
      await rm(botRoot(this.config.stateDir, found), { recursive: true, force: true });
      return removed;
    } finally {
      await release();
    }
  }

  private async dropComputer(bot: Pick<Bot, "id" | "chief">): Promise<void> {
    this.restartIdle(bot.id);
    await this.workspaceFor(bot).remove();
    this.workspaces.delete(bot.id);
  }

  /** The route's session: the live one when it is current, otherwise loaded from where it was saved. */
  async sessionFor(route: Route): Promise<AgentSession> {
    return (await this.liveFor(route.id)).live.session;
  }

  /** Whether this process is running a prompt or delegation on the bot. */
  isBusy(botId: string): boolean {
    return this.activeBots.has(botId);
  }

  /**
   * Runs one prompt on the route. A prompt waits for its bot's other work in this process, and
   * throws `BotBusy` when another process is running the bot.
   */
  async prompt(route: Route, text: string, opts: PromptOptions = {}): Promise<Answer> {
    const releaseBot = await this.holdRouteBot(route.id);
    let release: (() => void) | undefined;
    let live: Live | undefined;
    try {
      release = await this.lockRoute(route.id);
      const found = await this.liveFor(route.id);
      live = found.live;
      live.busy = true;
      await recordChat(this.store, found.bot.id, "user", text);
      const answer = await this.run(live, text, opts.onEvent);
      await this.persist(found.route, found.bot, live);
      await recordChat(this.store, found.bot.id, "assistant", answer.text);
      return answer;
    } finally {
      if (live) {
        live.busy = false;
        live.touched = this.now();
      }
      release?.();
      await releaseBot();
    }
  }

  /** Stops the route's running prompt, if any. */
  async abort(route: Route): Promise<void> {
    const current = await this.current(route.id);
    await this.live.get(keyOf(current))?.session.request("abort");
  }

  async state(route: Route): Promise<RouteState> {
    const current = await this.current(route.id);
    const live = this.live.get(keyOf(current));
    if (live) {
      const reply = await live.session.request("get_state");
      const state = reply.data as SessionState;
      return { ...state, sessionFile: live.sessionFile };
    }
    return {
      sessionId: current.session,
      sessionFile: current.sessionFile,
      model: { provider: current.provider, id: current.model },
      isStreaming: false,
    };
  }

  /** Forgets the route's session so its next prompt starts a new one. */
  async fresh(route: Route): Promise<Route> {
    const release = await this.lockRoute(route.id);
    try {
      const current = await this.current(route.id);
      this.drop(keyOf(current));
      // A transcript in another format is kept for reading; only our own files are removed.
      if (
        this.config.sessionsDir !== null &&
        current.sessionFile &&
        ownFormat(current.sessionFile)
      ) {
        await unlink(current.sessionFile).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err;
        });
      }
      return await this.store.persistRoute(current, {
        session: null,
        sessionFile: null,
        title: null,
      });
    } finally {
      release();
    }
  }

  /** Points the route at another bot, resuming whatever that bot had on this route. */
  async switchBot(route: Route, bot: Pick<Bot, "id">): Promise<Route> {
    const release = await this.lockRoute(route.id);
    try {
      return await this.store.switchBot(await this.current(route.id), bot.id);
    } finally {
      release();
    }
  }

  /** Runs one task on another bot's saved session and returns its answer. */
  async delegate(
    route: Route,
    bot: Pick<Bot, "id">,
    task: string,
    opts: PromptOptions & { policy?: Policy; signal?: AbortSignal | undefined } = {},
  ): Promise<string> {
    const target = await this.store.bot(bot.id);
    if (!target) throw new Error("The bot was deleted");
    const from = await this.store.getRoute(route.id);
    if (from?.bot === target.id) {
      throw new Error("A bot cannot delegate back into a workspace that is still running");
    }
    const answer = await this.onSaved(route, target, task, { ...opts, readOnly: false });
    if (answer.outcome !== "completed") throw new RunFailed(answer.outcome, answer.text);
    return answer.text;
  }

  /**
   * Runs a background task on the bot's saved session and saves it afterwards, as a delegation
   * does. A read-only run is given only the tools that change nothing. Without a policy the
   * gateway's own applies. Aborting `signal` stops the run. Throws `BotBusy` when the bot is
   * already working.
   */
  async background(
    route: Route,
    bot: Pick<Bot, "id">,
    task: string,
    opts: PromptOptions & { policy?: Policy | undefined; readOnly: boolean; signal: AbortSignal },
  ): Promise<Answer> {
    const target = await this.store.bot(bot.id);
    if (!target) throw new Error("The bot was deleted");
    return this.onSaved(route, target, task, opts);
  }

  /**
   * Runs one task on the bot's saved session, or a new one, and saves where it is. The bot is
   * held for the whole run, so the saved session is read and written by one run at a time. A
   * session with no file has nowhere to be resumed from, so its transcript is freed at the end.
   */
  private async onSaved(
    route: Route,
    target: Bot,
    task: string,
    opts: PromptOptions & { policy?: Policy | undefined; readOnly: boolean; signal?: AbortSignal },
  ): Promise<Answer> {
    const releaseBot = await this.holdBot(target.id, false);
    let id: string | undefined;
    let sessionFile: string | null = null;
    let release: (() => void) | undefined;
    let live: Live | undefined;
    const stop = () => void live?.session.request("abort").catch(() => {});
    opts.signal?.addEventListener("abort", stop, { once: true });
    try {
      const saved =
        this.config.sessionsDir === null ? null : await savedFile(this.store, target.id);
      id = saved ? basename(saved, ".jsonl") : randomUUID();
      sessionFile = saved ?? (await this.newFile(id));
      if (!saved && sessionFile) await rememberSession(this.store, target.id, { sessionFile });
      release = await this.lockFor(sessionKey(id)).acquire();
      // A cached copy would miss this run's messages; it reloads on its next use.
      this.drop(sessionKey(id));
      const built = await this.build(target);
      const tools = opts.readOnly ? built.tools.filter((t) => t.readOnly) : built.tools;
      live = await this.create(target, { ...built, tools }, id, sessionFile, {
        model: this.config.model,
        policy: opts.policy,
        route,
      });
      live.busy = true;
      this.delegations.add(live);
      await recordChat(this.store, target.id, "user", task);
      // Nothing awaits between this check and the prompt, so a stop cannot fall between them.
      if (opts.signal?.aborted) return { text: "", outcome: "cancelled" };
      const answer = await this.run(live, task, opts.onEvent);
      await rememberSession(this.store, target.id, { sessionFile });
      await recordChat(this.store, target.id, "assistant", answer.text);
      return answer;
    } finally {
      opts.signal?.removeEventListener("abort", stop);
      if (live) {
        live.busy = false;
        live.listener = undefined;
        this.delegations.delete(live);
      }
      if (id !== undefined) {
        // Anything loaded while this ran missed its messages.
        this.drop(sessionKey(id));
        if (sessionFile === null) {
          this.memory.forget(id);
          this.locks.delete(sessionKey(id));
        }
      }
      release?.();
      await releaseBot();
    }
  }

  /**
   * An observer that hands a run's approval events to `approvals` on behalf of the conversation
   * that started the run. Without a relay nobody answers them and their deadline denies them.
   */
  relayApprovals(route: Route, actor: number): EventObserver {
    return (event, source) => {
      if (event.type !== "approval_requested" && event.type !== "approval_resolved") return;
      this.approvals?.({ route, actor }, event, source);
    };
  }

  /** How many transcripts are held in memory, for conversations without session files. */
  transcriptsInMemory(): number {
    return this.memory.size();
  }

  /** Closes idle sessions (only the bot's, when given) so changed settings apply on next use. */
  restartIdle(botId?: string): void {
    for (const [key, live] of this.live) {
      if (live.busy || (botId !== undefined && live.botId !== botId)) continue;
      this.live.delete(key);
    }
  }

  /** Closes sessions nobody has used for `idleSeconds`. */
  sweep(now: number = this.now()): void {
    for (const [key, live] of this.live) {
      if (!live.busy && now - live.touched > this.config.idleSeconds) this.live.delete(key);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    const running = [...this.live.values(), ...this.delegations].filter((l) => l.busy);
    this.live.clear();
    await Promise.allSettled(running.map((l) => l.session.request("abort")));
    // Stopping keeps each computer's files; it starts again on next use.
    await Promise.allSettled([...this.workspaces.values()].map((ws) => ws.stop()));
  }

  private now(): number {
    return this.store.ctx.clock();
  }

  private lockFor(key: string): Mutex {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(key, lock);
    }
    return lock;
  }

  /** Holds the bot the route is on, rechecking in case the route moved to another while waiting. */
  private async holdRouteBot(routeId: number): Promise<() => Promise<void>> {
    for (;;) {
      const botId = await this.botOf(await this.current(routeId));
      const release = await this.holdBot(botId, true);
      if ((await this.botOf(await this.current(routeId))) === botId) return release;
      await release();
    }
  }

  private async botOf(route: Route): Promise<string> {
    return route.bot ?? (await this.store.chief()).id;
  }

  /**
   * Holds a bot for one run: in this process by its lock, and across processes by a database
   * lease kept alive while the run lasts. Without `wait`, a bot busy here is refused at once.
   */
  private async holdBot(botId: string, wait: boolean): Promise<() => Promise<void>> {
    if (!wait && this.activeBots.has(botId)) throw new BotBusy();
    const unlock = await this.lockFor(`bot:${botId}`).acquire();
    this.activeBots.add(botId);
    const lease = new Lease(this.store.ctx.db, `bot-${botId}`, {
      ttlSeconds: BOT_LEASE_SECONDS,
      clock: () => this.now() * 1000,
    });
    let held = false;
    try {
      held = await lease.acquire();
    } finally {
      if (!held) {
        this.activeBots.delete(botId);
        unlock();
      }
    }
    if (!held) throw new BotBusy();
    const renewal = setInterval(
      () => void lease.renew().catch(() => {}),
      (BOT_LEASE_SECONDS * 1000) / 3,
    );
    renewal.unref();
    return async () => {
      clearInterval(renewal);
      try {
        await lease.release();
      } catch (error) {
        // The run has ended either way; the hold runs out by itself once it is not renewed.
        console.warn(`Could not release the hold on bot ${botId}:`, error);
      } finally {
        this.activeBots.delete(botId);
        unlock();
      }
    };
  }

  /** Locks whatever session the route points at, rechecking in case it moved while waiting. */
  private async lockRoute(routeId: number): Promise<() => void> {
    for (;;) {
      const key = keyOf(await this.current(routeId));
      const release = await this.lockFor(key).acquire();
      if (keyOf(await this.current(routeId)) === key) return release;
      release();
    }
  }

  private async current(routeId: number): Promise<Route> {
    const route = await this.store.getRoute(routeId);
    if (!route) throw new Error(`No route ${routeId}`);
    return route;
  }

  /** Gives the route a session id (and file) if it has none, then returns its live session. */
  private async liveFor(routeId: number): Promise<{ live: Live; route: Route; bot: Bot }> {
    const release = await this.creating.acquire();
    try {
      let route = await this.current(routeId);
      const bot = await this.store.bot(route.bot ?? (await this.store.chief()).id);
      if (!bot) throw new Error("The bot was deleted");
      const local = this.config.sessionsDir !== null;
      if (local && route.sessionFile && !existsSync(route.sessionFile)) {
        throw new Error("The the saved session file is gone; start a fresh conversation.");
      }
      // A transcript in another format stays as it is; the route continues in a new session.
      const foreign = local && route.sessionFile !== null && !ownFormat(route.sessionFile);
      if (!route.session || foreign) {
        const earlier = foreign ? null : route.sessionFile;
        const id = earlier ? basename(earlier, ".jsonl") : randomUUID();
        const sessionFile = earlier ?? (await this.newFile(id));
        // Whoever waits on the route's lock now shares it under the session's name.
        if (!this.locks.has(sessionKey(id)))
          this.locks.set(sessionKey(id), this.lockFor(keyOf(route)));
        route = await this.store.persistRoute(route, { session: id, sessionFile });
      }
      const id = route.session as string;
      const built = await this.build(bot);
      const cached = this.live.get(sessionKey(id));
      if (
        cached &&
        (cached.busy || (cached.botId === bot.id && cached.signature === built.signature))
      ) {
        cached.touched = this.now();
        return { live: cached, route, bot };
      }
      const live = await this.create(bot, built, id, route.sessionFile, {
        model: route.model ?? this.config.model,
        route,
      });
      this.live.set(sessionKey(id), live);
      return { live, route, bot };
    } finally {
      release();
    }
  }

  /** Creates the bot's folders and gathers its prompt, tools and skills. */
  private async build(bot: Bot): Promise<Built> {
    const root = botRoot(this.config.stateDir, bot);
    const notesDir = join(root, "memory");
    mkdirSync(notesDir, { recursive: true });
    for (const file of MEMORY_FILES) {
      const path = join(notesDir, file);
      const title = file.replace(/\.md$/, "");
      if (!existsSync(path)) {
        writeFileSync(path, `# ${title[0]}${title.slice(1).toLowerCase()}\n`);
      }
    }
    mkdirSync(workspaceDir(this.config.stateDir, this.config.projectDir, bot), {
      recursive: true,
    });
    const settings = await profile(this.store, bot.id);
    const plugins = await this.store.pluginsFor(bot.id);
    const skills = loadSkills([join(root, "skills")]);
    const ws = this.workspaceFor(bot);
    const sections = [systemAddition(bot, notesDir, ws.memoryPath)];
    const style = STYLES[settings.style as keyof typeof STYLES] ?? "";
    const voice = settings.style === "custom" ? settings.voice : "";
    sections.push(["# Speaking style", style, voice].filter(Boolean).join("\n"));
    if (plugins.length > 0) sections.push(`# Apps\nYou may use these apps: ${plugins.join(", ")}.`);
    const system = buildSystem({ base: BASE, instructions: sections.join("\n\n"), skills });
    const tools = [...fileTools(ws), shellTool(ws)];
    const signature = JSON.stringify([
      system,
      skills.map((s) => [s.name, s.body]),
      tools.map((t) => t.name),
    ]);
    return { system, tools, skills, profile: settings, signature };
  }

  private async create(
    bot: Bot,
    built: Built,
    id: string,
    sessionFile: string | null,
    opts: { model: string; policy?: Policy | undefined; route: Route },
  ): Promise<Live> {
    const provider = this.providers(bot, built.profile);
    const { route } = opts;
    // Every bot may schedule its own jobs; only the chief manages the team. The person who owns
    // the route is who it acts for.
    const team = {
      hostTools: bot.chief ? [...teamTools(), ...jobTools()] : jobTools(),
      answerHostTool: (call: HostToolCall, signal: AbortSignal) =>
        answerTeamCall(
          {
            store: this.store,
            sessions: this,
            route,
            actor: route.user,
            agents: this.agents,
            bot,
            onEvent: this.relayApprovals(route, route.user),
            signal,
          },
          call,
        ),
    };
    const session = await AgentSession.open({
      id,
      providers: { [provider.id]: provider },
      provider: provider.id,
      model: opts.model,
      system: built.system,
      tools: built.tools,
      skills: built.skills,
      ...team,
      policy: opts.policy ?? this.config.policy,
      store: this.storeFor(sessionFile),
      clock: () => this.now(),
      ...(this.config.approvalSeconds === undefined
        ? {}
        : { approvalSeconds: this.config.approvalSeconds }),
    });
    return new Live(session, bot.id, built.signature, sessionFile, this.now());
  }

  private storeFor(sessionFile: string | null): SessionStore {
    return sessionFile && this.config.sessionsDir !== null
      ? jsonlSessionStore(dirname(sessionFile))
      : this.memory;
  }

  /** A new, empty session file, or null when transcripts stay in memory. */
  private async newFile(id: string): Promise<string | null> {
    const dir = this.config.sessionsDir;
    if (dir === null) return null;
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    await appendFile(file, "");
    return file;
  }

  /** Sends one prompt and waits for it to settle, passing each event on. */
  private async run(live: Live, text: string, onEvent?: EventObserver): Promise<Answer> {
    const source: EventSource = { session: live.session, bot: live.botId };
    const settled = new Promise<Answer>((resolve) => {
      let final = "";
      live.listener = (event) => {
        if (event.type === "response") return;
        try {
          onEvent?.(event, source);
        } catch {
          // A failing observer must not stop the run.
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          final = textOf(event.message.content) || final;
        }
        if (event.type === "agent_settled") {
          live.listener = undefined;
          resolve({ text: event.error ?? final, outcome: event.outcome });
        }
      };
    });
    const reply = await live.session.request("prompt", { message: text });
    if (!reply.success) {
      live.listener = undefined;
      throw new Error(reply.error ?? "The prompt was refused.");
    }
    return settled;
  }

  /** Saves where the route's session is and which model it used. */
  private async persist(route: Route, bot: Bot, live: Live): Promise<void> {
    const state = (await live.session.request("get_state")).data as SessionState;
    await this.store.persistRoute(route, {
      session: state.sessionId,
      sessionFile: live.sessionFile,
      provider: state.model.provider,
      model: state.model.id,
    });
    await rememberSession(this.store, bot.id, { sessionFile: live.sessionFile });
  }

  private drop(key: string): void {
    const live = this.live.get(key);
    if (live && !live.busy) this.live.delete(key);
  }
}

/** The bot's last saved session file, if it is still there. */
async function savedFile(store: Store, botId: string): Promise<string | null> {
  const file = await savedSession(store, botId);
  return file && existsSync(file) && ownFormat(file) ? file : null;
}

/**
 * Whether a session file is empty or holds this store's lines. Only the first non-empty line is
 * read, so the check stays cheap on long transcripts.
 */
export function ownFormat(file: string): boolean {
  const fd = openSync(file, "r");
  let text = "";
  try {
    const chunk = Buffer.alloc(65536);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      text += chunk.toString("utf8", 0, read);
      // Stop once a complete non-empty line is in hand.
      if (/\S[^\n]*\n/.test(text)) break;
    }
  } finally {
    closeSync(fd);
  }
  const first = text.split("\n").find((l) => l.trim());
  if (first === undefined) return true;
  try {
    const line: unknown = JSON.parse(first);
    if (!line || typeof line !== "object") return false;
    if ("reset" in line) return Array.isArray(line.reset);
    if (!("entry" in line)) return false;
    const entry = line.entry as { role?: unknown; content?: unknown } | null;
    return (
      !!entry &&
      ["user", "assistant", "tool"].includes(String(entry.role)) &&
      Array.isArray(entry.content)
    );
  } catch {
    return false;
  }
}
