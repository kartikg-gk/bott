import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import { CompactionError, compact, estimate, needsCompaction, SUMMARY_PREFIX } from "./budget.ts";
import { type AgentEvent, runAgentLoop, type ToolCall } from "./engine.ts";
import { makeBeforeToolCall, type Policy } from "./policy.ts";
import type { ModelProvider } from "./providers/types.ts";
import type { SessionStore } from "./sessionStore.ts";
import { memorySessionStore } from "./sessionStore.ts";
import { loadSkillTool, type Skill } from "./skills.ts";
import { errorOutput, type ToolOutput, type ToolSpec } from "./tools.ts";
import { type ModelEntry, type TranscriptEntry, textOf } from "./transcript.ts";

/** A tool the server answers, such as sending a photo to the chat. */
export interface HostTool {
  name: string;
  description: string;
  input: z.ZodTypeAny;
  readOnly: boolean;
  /** Always asks the person first, whatever the policy, unless the policy refuses everything. */
  review?: boolean;
}

export interface HostToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface SessionState {
  sessionId: string;
  model: { provider: string; id: string };
  isStreaming: boolean;
  /** What the session is doing now: "prompt" during a run, otherwise null. */
  operation: "prompt" | null;
  messageCount: number;
  pendingMessageCount: number;
}

export type Outcome = "completed" | "cancelled" | "failed";

/** Tool events also carry the field names clients read. */
type WithToolNames<E> = E extends { callId: string; name: string }
  ? E & { toolCallId: string; toolName: string }
  : E;

export type SessionEvent =
  | WithToolNames<AgentEvent>
  | {
      type: "approval_requested";
      id: string;
      approvalId: string;
      call: ToolCall;
      tool: string;
      preview: string;
      digest: string;
      /** Seconds since the epoch. */
      expiresAt: number;
    }
  | { type: "approval_resolved"; id: string; approvalId: string; allow: boolean }
  | {
      type: "host_tool_call";
      callId: string;
      name: string;
      arguments: unknown;
      call: HostToolCall;
    }
  | { type: "compaction_start"; reason: "manual" | "threshold" }
  | { type: "compaction_end"; reason: "manual" | "threshold"; summary?: string; error?: string }
  | { type: "agent_settled"; outcome: Outcome; state: SessionState; error?: string }
  | SessionResponse;

/** A command reply: `data` on success, `error` on failure. */
export interface SessionResponse {
  type: "response";
  /** The caller's request id, echoed so replies can be matched. */
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface SessionOptions {
  id: string;
  providers: Record<string, ModelProvider>;
  provider: string;
  model: string;
  system: string;
  tools?: ToolSpec[];
  skills?: Skill[];
  hostTools?: HostTool[];
  /** `signal` aborts when the run stops, so work the call started can stop with it. */
  answerHostTool?: (call: HostToolCall, signal: AbortSignal) => Promise<ToolOutput>;
  policy?: Policy;
  /** Whether shell commands run under Windows; this machine's platform when left out. */
  windowsShell?: boolean;
  store?: SessionStore;
  contextWindow?: number;
  /** Seconds since the epoch, as a float; approval deadlines are measured by it. */
  clock?: () => number;
  /** How long an approval waits for an answer before it is denied. */
  approvalSeconds?: number;
  /**
   * Nobody watches this session's runs, as in a scheduled job. A call that would wait for an
   * approval is refused at once, with a reason the model can read, instead of waiting out
   * the deadline.
   */
  unattended?: boolean;
}

/** Why a call that needs approval is refused in an unattended run. */
export const NOBODY_TO_ASK = "needs approval, and nobody can give it during a scheduled run";

/** How long an approval waits for an answer when the session is not told otherwise. */
export const APPROVAL_SECONDS = 300;
/** The longest delay a timer takes, in milliseconds. */
const MAX_TIMER = 2 ** 31 - 1;
const wallClock = () => Date.now() / 1000;

const userEntry = (text: string): TranscriptEntry => ({
  role: "user",
  content: [{ type: "text", text }],
});

/** One conversation: runs prompts through the agent loop and answers run commands. */
export class AgentSession {
  private transcript: TranscriptEntry[];
  private readonly store: SessionStore;
  private readonly tools: ToolSpec[];
  private providerName: string;
  private model: string;
  private run: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private steering: TranscriptEntry[] = [];
  private followUps: TranscriptEntry[] = [];
  private readonly approvals = new Map<string, (allow: boolean) => void>();
  private readonly queue: SessionEvent[] = [];
  private wake: (() => void) | undefined;
  private saving: Promise<void> = Promise.resolve();
  /** Tools that run without approval; grows when host tools are added mid-conversation. */
  private readonly readOnly = new Set<string>();
  private readonly reviewed = new Set<string>();

  private constructor(
    private readonly opts: SessionOptions,
    transcript: TranscriptEntry[],
  ) {
    this.transcript = transcript;
    this.store = opts.store ?? memorySessionStore();
    this.providerName = opts.provider;
    this.model = opts.model;
    this.tools = [
      ...(opts.tools ?? []),
      ...(opts.skills?.length ? [loadSkillTool(opts.skills)] : []),
    ];
    for (const t of this.tools) if (t.readOnly) this.readOnly.add(t.name);
    this.addHostTools(opts.hostTools ?? []);
  }

  /**
   * Offers more server-answered tools from the next model request on, such as an app's tools
   * once the bot loads it. Names already offered are skipped.
   */
  addHostTools(tools: HostTool[]): void {
    for (const t of tools) {
      if (this.tools.some((existing) => existing.name === t.name)) continue;
      this.tools.push(this.hostToolSpec(t));
      if (t.readOnly) this.readOnly.add(t.name);
      if (t.review) this.reviewed.add(t.name);
    }
  }

  static async open(opts: SessionOptions): Promise<AgentSession> {
    const store = opts.store ?? memorySessionStore();
    return new AgentSession({ ...opts, store }, await store.load(opts.id));
  }

  /** Events in order. One reader at a time; a reader that stops leaves the rest queued. */
  async *events(): AsyncIterable<SessionEvent> {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  /** Answers one command. `args.id` is the request id; the reply echoes it and is also emitted. */
  async request(command: string, args: Record<string, unknown> = {}): Promise<SessionResponse> {
    const { id, ...rest } = args;
    const base =
      typeof id === "string"
        ? { type: "response" as const, id, command }
        : { type: "response" as const, command };
    let response: SessionResponse;
    try {
      response = { ...base, success: true, data: await this.handle(command, rest) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      response = { ...base, success: false, error };
    }
    this.emit(response);
    return response;
  }

  private async handle(command: string, args: Record<string, unknown>): Promise<unknown> {
    const message = () => {
      if (typeof args.message !== "string" || !args.message) {
        throw new Error(`${command} needs a message.`);
      }
      return args.message;
    };
    switch (command) {
      case "prompt": {
        const text = message();
        if (this.run) throw new Error("The agent is already working.");
        this.controller = new AbortController();
        this.run = this.execute(text, this.controller.signal).finally(() => {
          this.run = undefined;
        });
        return undefined;
      }
      case "abort":
        this.controller?.abort();
        for (const resolve of this.approvals.values()) resolve(false);
        await this.run;
        return undefined;
      case "steer":
      case "follow_up": {
        const text = message();
        if (args.requireActive === true && !this.run) {
          throw new Error(`There is no active run to take this ${command} message.`);
        }
        (command === "steer" ? this.steering : this.followUps).push(userEntry(text));
        return undefined;
      }
      case "respond_to_approval": {
        const approvalId = String(args.approvalId);
        const resolve = this.approvals.get(approvalId);
        if (!resolve) throw new Error(`No approval is waiting with id ${approvalId}.`);
        resolve(args.allow === true);
        return undefined;
      }
      case "compact": {
        if (this.run) throw new Error("Cannot compact while the agent is working.");
        const error = await this.compactNow("manual", this.lastRequest(), new AbortController());
        if (error) throw new Error(error);
        return { messageCount: this.transcript.length };
      }
      case "get_state":
        return this.state();
      case "get_session_stats":
        return this.stats();
      case "set_model": {
        const provider = String(args.provider);
        if (!this.opts.providers[provider]) throw new Error(`Unknown provider ${provider}.`);
        if (typeof args.model !== "string" || !args.model)
          throw new Error("set_model needs a model.");
        this.providerName = provider;
        this.model = args.model;
        return this.state().model;
      }
      default:
        throw new Error(`Unknown command ${command}.`);
    }
  }

  private emit(event: SessionEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = undefined;
  }

  private state(): SessionState {
    return {
      sessionId: this.opts.id,
      model: { provider: this.providerName, id: this.model },
      isStreaming: this.run !== undefined,
      operation: this.run ? "prompt" : null,
      messageCount: this.transcript.length,
      pendingMessageCount: this.steering.length + this.followUps.length,
    };
  }

  private stats() {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const e of this.transcript) {
      if (e.role !== "assistant") continue;
      tokens.input += e.usage.input;
      tokens.output += e.usage.output;
      tokens.cacheRead += e.usage.cacheRead;
      tokens.cacheWrite += e.usage.cacheWrite;
    }
    const window = this.opts.contextWindow ?? 128_000;
    const est = estimate(this.transcript, this.tools, window);
    return {
      sessionId: this.opts.id,
      totalMessages: this.transcript.length,
      tokens,
      contextUsage: { tokens: est.tokens, contextWindow: window, percent: 100 * est.utilization },
    };
  }

  /** The latest prompt the person typed, skipping summaries. */
  private lastRequest(): string | undefined {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const entry = this.transcript[i];
      if (entry?.role !== "user") continue;
      const text = textOf(entry.content);
      if (!text.startsWith(SUMMARY_PREFIX)) return text;
    }
    return undefined;
  }

  /** Compacts the transcript; returns the error text when the summary failed. */
  private async compactNow(
    reason: "manual" | "threshold",
    currentRequest: string | undefined,
    controller: AbortController,
  ): Promise<string | undefined> {
    this.emit({ type: "compaction_start", reason });
    try {
      const out = await compact({
        provider: this.provider(),
        model: this.model,
        transcript: this.transcript,
        currentRequest,
        signal: controller.signal,
      });
      if (out.transcript !== this.transcript) {
        this.transcript = out.transcript;
        await this.saving;
        await this.store.replace(this.opts.id, this.transcript);
      }
      this.emit({ type: "compaction_end", reason, summary: out.summary });
      return undefined;
    } catch (err) {
      if (!(err instanceof CompactionError)) throw err;
      this.emit({ type: "compaction_end", reason, error: err.message });
      return err.message;
    }
  }

  /** Before each model request: compacts when the history is past the threshold. */
  private async compactIfFull(
    messages: TranscriptEntry[],
    request: string,
  ): Promise<TranscriptEntry[] | undefined> {
    const window = this.opts.contextWindow ?? 128_000;
    if (!needsCompaction(estimate(messages, this.tools, window))) return undefined;
    this.transcript = messages;
    // A failed summary is reported and the run continues uncompacted.
    const error = await this.compactNow(
      "threshold",
      request,
      this.controller ?? new AbortController(),
    );
    return error ? undefined : this.transcript;
  }

  private provider(): ModelProvider {
    const provider = this.opts.providers[this.providerName];
    if (!provider) throw new Error(`Unknown provider ${this.providerName}.`);
    return provider;
  }

  private async execute(text: string, signal: AbortSignal): Promise<void> {
    const prompt = userEntry(text);
    let outcome: Outcome = "completed";
    let error: string | undefined;
    try {
      const ask = (call: ToolCall) => this.askApproval(call, signal);
      const policy = this.opts.policy ?? "engine";
      const decide = makeBeforeToolCall(policy, ask, this.readOnly, this.opts.windowsShell);
      let last: ModelEntry | undefined;
      for await (const event of runAgentLoop({
        provider: this.provider(),
        model: this.model,
        system: this.opts.system,
        messages: this.transcript,
        prompts: [prompt],
        tools: this.tools,
        signal,
        steering: () => this.steering.splice(0),
        followUps: () => this.followUps.splice(0),
        // A reviewed tool asks every time; it is refused outright only when the policy denies.
        beforeToolCall: (call) => {
          const reviewed = this.reviewed.has(call.name) && policy !== "deny";
          const asks = reviewed || (policy === "ask" && !this.readOnly.has(call.name));
          if (asks && this.opts.unattended === true) {
            return Promise.resolve({ allow: false, reason: `${call.name} ${NOBODY_TO_ASK}.` });
          }
          return reviewed
            ? makeBeforeToolCall("ask", ask, this.readOnly, this.opts.windowsShell)(call)
            : decide(call);
        },
        beforeModelRequest: (messages) => this.compactIfFull(messages, text),
        cacheKey: this.opts.id,
      })) {
        if (event.type === "message_end") {
          this.transcript = [...this.transcript, event.message];
          this.persist(event.message);
          if (event.message.role === "assistant") last = event.message;
        }
        this.emit(withToolNames(event));
      }
      if (signal.aborted || last?.stop === "aborted") outcome = "cancelled";
      else if (last?.stop === "error") {
        outcome = "failed";
        error = last.error;
      }
    } catch (err) {
      outcome = signal.aborted ? "cancelled" : "failed";
      error = err instanceof Error ? err.message : String(err);
    }
    try {
      await this.saving;
    } catch (err) {
      outcome = "failed";
      error = `Could not save the session: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.saving = Promise.resolve();
    this.run = undefined;
    this.emit({
      type: "agent_settled",
      outcome,
      state: this.state(),
      ...(error ? { error } : {}),
    });
  }

  private persist(entry: TranscriptEntry): void {
    this.saving = this.saving.then(() => this.store.append(this.opts.id, [entry]));
  }

  /**
   * Asks whoever reads the events whether the call may run. Nobody may be listening, so the
   * session denies the call itself once its deadline passes by the session's clock.
   */
  private askApproval(call: ToolCall, signal: AbortSignal): Promise<boolean> {
    const id = randomUUID();
    const clock = this.opts.clock ?? wallClock;
    const expiresAt = Math.floor(clock()) + (this.opts.approvalSeconds ?? APPROVAL_SECONDS);
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (allow: boolean) => {
        if (!this.approvals.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.emit({ type: "approval_resolved", id, approvalId: id, allow });
        resolve(allow);
      };
      const onAbort = () => settle(false);
      // A longer delay would overflow the timer; one that fires early sets itself again.
      const arm = () => {
        const left = (expiresAt - clock()) * 1000;
        timer = setTimeout(
          () => (clock() < expiresAt ? arm() : settle(false)),
          Math.min(MAX_TIMER, Math.max(0, left)),
        );
        timer.unref();
      };
      // An answer that comes after the deadline is a denial.
      this.approvals.set(id, (allow) => settle(allow && clock() < expiresAt));
      const input = JSON.stringify(call.input) ?? "";
      this.emit({
        type: "approval_requested",
        id,
        approvalId: id,
        call,
        tool: call.name,
        preview: input.length > 1000 ? `${input.slice(0, 1000)}...` : input,
        digest: createHash("sha256")
          .update(`${call.name}
${input}`)
          .digest("hex"),
        expiresAt,
      });
      if (signal.aborted) settle(false);
      else {
        signal.addEventListener("abort", onAbort);
        if (this.approvals.has(id)) arm();
      }
    });
  }

  private hostToolSpec(tool: HostTool): ToolSpec {
    return {
      ...tool,
      run: async (input, { signal, callId }) => {
        const answer = this.opts.answerHostTool;
        if (!answer) return errorOutput(`${tool.name} has no server to answer it.`);
        const call: HostToolCall = { id: callId ?? randomUUID(), name: tool.name, input };
        this.emit({
          type: "host_tool_call",
          callId: call.id,
          name: call.name,
          arguments: input,
          call,
        });
        let onAbort = () => {};
        const aborted = new Promise<ToolOutput>((resolve) => {
          onAbort = () => resolve(errorOutput("Tool call was aborted."));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          return await Promise.race([answer(call, signal), aborted]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
    };
  }
}

function withToolNames(event: AgentEvent): SessionEvent {
  if ("callId" in event && "name" in event) {
    return { ...event, toolCallId: event.callId, toolName: event.name } as SessionEvent;
  }
  return event as SessionEvent;
}
