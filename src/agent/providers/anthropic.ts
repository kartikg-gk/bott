import { type Block, emptyUsage, type StopReason, type TranscriptEntry } from "../transcript.ts";
import { endedEarly, isAbort, openStream, sseData, toolSchema } from "./http.ts";
import type { FetchFn, ModelProvider, ProviderRequest, StreamEvent } from "./types.ts";

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
}

const DEFAULT_MAX_TOKENS = 8192;

const STOP: Record<string, StopReason> = {
  end_turn: "end",
  tool_use: "tool_calls",
  max_tokens: "length",
};

type Json = Record<string, unknown>;

function toMessages(entries: TranscriptEntry[]): Json[] {
  const out: Json[] = [];
  const push = (role: "user" | "assistant", content: Json[]) => {
    if (content.length === 0) return;
    const last = out.at(-1);
    if (last && last.role === role) (last.content as Json[]).push(...content);
    else out.push({ role, content });
  };
  const textBlocks = (blocks: Block[]) =>
    blocks.flatMap((b): Json[] =>
      b.type === "text" && b.text ? [{ type: "text", text: b.text }] : [],
    );

  for (const entry of entries) {
    if (entry.role === "user") {
      push("user", textBlocks(entry.content));
    } else if (entry.role === "assistant") {
      // Signed thinking goes back unchanged and in order; unsigned thinking (from an aborted
      // stream) would be rejected by the API, so it is left out.
      const content = entry.content.flatMap((b): Json[] => {
        if (b.type === "thinking")
          return b.signature
            ? [{ type: "thinking", thinking: b.text, signature: b.signature }]
            : [];
        if (b.type === "redacted_thinking") return [{ type: "redacted_thinking", data: b.data }];
        if (b.type === "text") return b.text ? [{ type: "text", text: b.text }] : [];
        if (b.type === "call")
          return [{ type: "tool_use", id: b.id, name: b.name, input: b.input }];
        return [];
      });
      push("assistant", content);
    } else {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: entry.callId,
          content: textBlocks(entry.content),
          is_error: entry.isError,
        },
      ]);
    }
  }
  return out;
}

function buildBody(req: ProviderRequest): Json {
  const body: Json = {
    model: req.model,
    max_tokens: DEFAULT_MAX_TOKENS,
    stream: true,
    messages: toMessages(req.messages),
  };
  if (req.system) {
    body.system = [
      {
        type: "text",
        text: req.system,
        ...(req.cacheKey ? { cache_control: { type: "ephemeral" } } : {}),
      },
    ];
  }
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toolSchema(t),
    }));
  }
  if (req.thinking) {
    body.thinking = { type: "enabled", budget_tokens: req.thinking.budgetTokens };
    body.max_tokens = Math.max(DEFAULT_MAX_TOKENS, req.thinking.budgetTokens + 4096);
  }
  return body;
}

export function anthropicProvider(options: AnthropicOptions): ModelProvider {
  const fetchFn = options.fetch ?? fetch;
  const url = `${(options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
  const label = "anthropic";

  return {
    id: label,
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
      const opened = await openStream(
        fetchFn,
        label,
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(buildBody(req)),
          signal: req.signal,
        },
        options.apiKey,
      );
      const usage = emptyUsage();
      let model = req.model;
      const content: Block[] = [];
      const finish = (stop: StopReason, error?: string): StreamEvent => ({
        type: "end",
        entry: { role: "assistant", content, model, usage, stop, ...(error ? { error } : {}) },
      });
      if (!opened.ok) {
        yield opened.event === "aborted" ? finish("aborted") : opened.event;
        return;
      }

      const open = new Map<
        number,
        { type: string; id?: string; name?: string; text: string; signature: string }
      >();
      let stop: StopReason | undefined;
      try {
        yield { type: "start", model };
        for await (const data of sseData(opened.response, req.signal)) {
          let event: Json;
          try {
            event = JSON.parse(data) as Json;
          } catch {
            continue;
          }
          const index = Number(event.index);
          switch (event.type) {
            case "message_start": {
              const message = (event.message ?? {}) as Json;
              const u = (message.usage ?? {}) as Json;
              if (typeof message.model === "string") model = message.model;
              usage.input = Number(u.input_tokens ?? 0);
              usage.cacheRead = Number(u.cache_read_input_tokens ?? 0);
              usage.cacheWrite = Number(u.cache_creation_input_tokens ?? 0);
              usage.output = Number(u.output_tokens ?? 0);
              break;
            }
            case "content_block_start": {
              const block = (event.content_block ?? {}) as Json;
              open.set(index, {
                type: String(block.type),
                id: block.id as string | undefined,
                name: block.name as string | undefined,
                text: block.type === "redacted_thinking" ? String(block.data ?? "") : "",
                signature: "",
              });
              break;
            }
            case "content_block_delta": {
              const slot = open.get(index);
              const delta = (event.delta ?? {}) as Json;
              if (!slot) break;
              if (delta.type === "text_delta") {
                const text = String(delta.text ?? "");
                slot.text += text;
                yield { type: "text_delta", text };
              } else if (delta.type === "thinking_delta") {
                const text = String(delta.thinking ?? "");
                slot.text += text;
                yield { type: "thinking_delta", text };
              } else if (delta.type === "signature_delta") {
                slot.signature += String(delta.signature ?? "");
              } else if (delta.type === "input_json_delta") {
                slot.text += String(delta.partial_json ?? "");
              }
              break;
            }
            case "content_block_stop": {
              const slot = open.get(index);
              open.delete(index);
              if (!slot) break;
              if (slot.type === "text") content.push({ type: "text", text: slot.text });
              else if (slot.type === "thinking")
                content.push({
                  type: "thinking",
                  text: slot.text,
                  ...(slot.signature ? { signature: slot.signature } : {}),
                });
              else if (slot.type === "redacted_thinking")
                content.push({ type: "redacted_thinking", data: slot.text });
              else if (slot.type === "tool_use") {
                let input: unknown = {};
                try {
                  if (slot.text.trim()) input = JSON.parse(slot.text);
                } catch {
                  yield {
                    type: "error",
                    message: `${label} sent malformed arguments for ${slot.name}`,
                  };
                  return;
                }
                const call = { id: slot.id ?? "", name: slot.name ?? "", input };
                content.push({ type: "call", ...call });
                yield { type: "call", ...call };
              }
              break;
            }
            case "message_delta": {
              const delta = (event.delta ?? {}) as Json;
              const u = (event.usage ?? {}) as Json;
              if (u.output_tokens !== undefined) usage.output = Number(u.output_tokens);
              if (typeof delta.stop_reason === "string") stop = STOP[delta.stop_reason] ?? "end";
              break;
            }
            case "error": {
              const err = (event.error ?? {}) as Json;
              yield {
                type: "error",
                message: `${label} stream error: ${String(err.message ?? err.type ?? "unknown")}`,
                retryable: content.length === 0 && err.type === "overloaded_error",
              };
              return;
            }
          }
        }
      } catch (err) {
        if (!isAbort(err, req.signal)) {
          yield endedEarly(label, options.apiKey, err);
          return;
        }
      }
      if (req.signal.aborted) {
        for (const slot of [...open].sort((a, b) => a[0] - b[0]).map(([, s]) => s)) {
          if (slot.text && slot.type === "text") content.push({ type: "text", text: slot.text });
          if (slot.text && slot.type === "thinking")
            content.push({ type: "thinking", text: slot.text });
        }
        yield finish("aborted");
        return;
      }
      if (stop === undefined) {
        yield endedEarly(label, options.apiKey);
        return;
      }
      yield finish(stop);
    },
  };
}
