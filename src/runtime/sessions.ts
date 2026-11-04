import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { buildSystem } from "../agent/instructions.ts";
import type { Policy } from "../agent/policy.ts";
import type { ModelProvider } from "../agent/providers/types.ts";
import {
  AgentSession,
  type Outcome,
  type SessionEvent,
  type SessionState,
} from "../agent/session.ts";
import { jsonlSessionStore, memorySessionStore, type SessionStore } from "../agent/sessionStore.ts";
import { loadSkills, type Skill } from "../agent/skills.ts";
import { fileTools } from "../agent/tools/files.ts";
import { shellTool } from "../agent/tools/shell.ts";
import { localWorkspace, type Workspace } from "../agent/tools/workspace.ts";
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
import type { Route } from "../store/routes.ts";
import type { Store } from "../store/store.ts";

export interface RuntimeConfig {
  stateDir: string;
  projectDir: string;
  /** Where session files go; null keeps transcripts in memory (hosted). */
  sessionsDir: string | null;
  policy: Policy;
  model: string;
  idleSeconds: number;
}

/** Makes the model provider a bot's session talks to. */
export type ProviderFactory = (bot: Bot, profile: Profile) => ModelProvider;

export interface PromptOptions {
  onEvent?: (event: SessionEvent) => void;
}

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
const keyOf = (route: Route) => (route.session ? sessionKey(route.session) : routeKey(route.id));

/** Keeps one agent session per conversation and runs its prompts one at a time. */
export class SessionManager {
  private readonly live = new Map<string, Live>();
  private readonly delegations = new Set<Live>();
  private readonly locks = new Map<string, Mutex>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly creating = new Mutex();
  /** Hosted transcripts, kept for as long as this manager lives. */
  private readonly memory = memorySessionStore();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: Store,
    private readonly providers: ProviderFactory,
  ) {
    const every = Math.max(1, Math.min(config.idleSeconds, SWEEP_SECONDS));
    this.timer = setInterval(() => this.sweep(), every * 1000);
    this.timer.unref();
  }

  /** Where a bot's files live and its commands run. Other computers plug in here. */
  workspaceFor(bot: Bot): Workspace {
    let found = this.workspaces.get(bot.id);
    if (!found) {
      found = localWorkspace(workspaceDir(this.config.stateDir, this.config.projectDir, bot));
      this.workspaces.set(bot.id, found);
    }
    return found;
  }

  /** The route's session: the live one when it is current, otherwise loaded from where it was saved. */
  async sessionFor(route: Route): Promise<AgentSession> {
    return (await this.liveFor(route.id)).live.session;
  }

  async prompt(route: Route, text: string, opts: PromptOptions = {}): Promise<Answer> {
    const release = await this.lockRoute(route.id);
    let live: Live | undefined;
    try {
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
      release();
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
      if (this.config.sessionsDir !== null && current.sessionFile) {
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
    opts: PromptOptions & { policy?: Policy } = {},
  ): Promise<string> {
    const target = await this.store.bot(bot.id);
    if (!target) throw new Error("The bot was deleted");
    const from = await this.store.getRoute(route.id);
    if (from?.bot === target.id) {
      throw new Error("A bot cannot delegate back into a workspace that is still running");
    }
    const saved = this.config.sessionsDir === null ? null : await savedFile(this.store, target.id);
    const id = saved ? basename(saved, ".jsonl") : randomUUID();
    const sessionFile = saved ?? (await this.newFile(id));
    const release = await this.lockFor(sessionKey(id)).acquire();
    let live: Live | undefined;
    try {
      // A cached copy would miss this run's messages; it reloads on its next use.
      this.drop(sessionKey(id));
      live = await this.create(target, await this.build(target), id, sessionFile, {
        model: this.config.model,
        policy: opts.policy,
      });
      live.busy = true;
      this.delegations.add(live);
      await recordChat(this.store, target.id, "user", task);
      const answer = await this.run(live, task, opts.onEvent);
      await rememberSession(this.store, target.id, { sessionFile });
      await recordChat(this.store, target.id, "assistant", answer.text);
      if (answer.outcome !== "completed") throw new RunFailed(answer.outcome, answer.text);
      return answer.text;
    } finally {
      if (live) {
        live.busy = false;
        live.listener = undefined;
        this.delegations.delete(live);
      }
      release();
    }
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
      if (!route.session) {
        const id = route.sessionFile ? basename(route.sessionFile, ".jsonl") : randomUUID();
        const sessionFile = route.sessionFile ?? (await this.newFile(id));
        // Whoever waits on the route's lock now shares it under the session's name.
        if (!this.locks.has(sessionKey(id))) {
          this.locks.set(sessionKey(id), this.lockFor(routeKey(route.id)));
        }
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
    const sections = [systemAddition(bot, notesDir)];
    const style = STYLES[settings.style as keyof typeof STYLES] ?? "";
    const voice = settings.style === "custom" ? settings.voice : "";
    sections.push(["# Speaking style", style, voice].filter(Boolean).join("\n"));
    if (plugins.length > 0) sections.push(`# Apps\nYou may use these apps: ${plugins.join(", ")}.`);
    const system = buildSystem({ base: BASE, instructions: sections.join("\n\n"), skills });
    const ws = this.workspaceFor(bot);
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
    opts: { model: string; policy?: Policy | undefined },
  ): Promise<Live> {
    const provider = this.providers(bot, built.profile);
    const session = await AgentSession.open({
      id,
      providers: { [provider.id]: provider },
      provider: provider.id,
      model: opts.model,
      system: built.system,
      tools: built.tools,
      skills: built.skills,
      policy: opts.policy ?? this.config.policy,
      store: this.storeFor(sessionFile),
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
  private async run(
    live: Live,
    text: string,
    onEvent?: (event: SessionEvent) => void,
  ): Promise<Answer> {
    const settled = new Promise<Answer>((resolve) => {
      let final = "";
      live.listener = (event) => {
        if (event.type === "response") return;
        try {
          onEvent?.(event);
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
  return file && existsSync(file) ? file : null;
}
