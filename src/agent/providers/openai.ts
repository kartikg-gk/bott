import {
  type Block,
  emptyUsage,
  type StopReason,
  type TranscriptEntry,
  textOf,
} from "../transcript.ts";
import { endedEarly, isAbort, openStream, sseData, toolSchema } from "./http.ts";
import type { FetchFn, ModelProvider, ProviderRequest, StreamEvent } from "./types.ts";

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseUrl: string;
  id: string;
  fetch?: FetchFn;
}

const STOP: Record<string, StopReason> = {
  stop: "end",
  tool_calls: "tool_calls",
  length: "length",
};

type Json = Record<string, unknown>;

function toMessages(system: string, entries: TranscriptEntry[]): Json[] {
  const out: Json[] = system ? [{ role: "system", content: system }] : [];
  for (const entry of entries) {
    if (entry.role === "user") {
      out.push({ role: "user", content: textOf(entry.content) });
    } else if (entry.role === "assistant") {
      const text = textOf(entry.content);
      const calls = entry.content.filter(
        (b): b is Extract<Block, { type: "call" }> => b.type === "call",
      );
      if (!text && calls.length === 0) continue;
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: "tool", tool_call_id: entry.callId, content: textOf(entry.content) });
    }
  }
  return out;
}

function buildBody(req: ProviderRequest): Json {
  const body: Json = {
    model: req.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: toMessages(req.system, req.messages),
  };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: toolSchema(t) },
    }));
  }
  if (req.cacheKey) body.prompt_cache_key = req.cacheKey;
  return body;
}

export function openAICompatibleProvider(options: OpenAICompatibleOptions): ModelProvider {
  const fetchFn = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const label = options.id;

  return {
    id: options.id,
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
      const opened = await openStream(
        fetchFn,
        label,
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(buildBody(req)),
          signal: req.signal,
        },
        options.apiKey,
      );
      const usage = emptyUsage();
      let model = req.model;
      const content: Block[] = [];
      const finish = (stop: StopReason): StreamEvent => ({
        type: "end",
        entry: { role: "assistant", content, model, usage, stop },
      });
      if (!opened.ok) {
        yield opened.event === "aborted" ? finish("aborted") : opened.event;
        return;
      }

      let text = "";
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let stop: StopReason | undefined;
      let callsEmitted = false;
      try {
        yield { type: "start", model };
        for await (const data of sseData(opened.response, req.signal)) {
          if (data.trim() === "[DONE]") break;
          let chunk: Json;
          try {
            chunk = JSON.parse(data) as Json;
          } catch {
            continue;
          }
          if (typeof chunk.model === "string") model = chunk.model;
          const u = chunk.usage as Json | null | undefined;
          if (u) {
            const details = (u.prompt_tokens_details ?? {}) as Json;
            usage.input = Number(u.prompt_tokens ?? 0);
            usage.output = Number(u.completion_tokens ?? 0);
            usage.cacheRead = Number(details.cached_tokens ?? 0);
          }
          const choice = ((chunk.choices as Json[] | undefined) ?? [])[0];
          if (!choice) continue;
          const delta = (choice.delta ?? {}) as Json;
          if (typeof delta.content === "string" && delta.content) {
            text += delta.content;
            yield { type: "text_delta", text: delta.content };
          }
          for (const part of (delta.tool_calls as Json[] | undefined) ?? []) {
            const index = Number(part.index ?? 0);
            const slot = calls.get(index) ?? { id: "", name: "", args: "" };
            const fn = (part.function ?? {}) as Json;
            if (typeof part.id === "string") slot.id = part.id;
            if (typeof fn.name === "string") slot.name += fn.name;
            if (typeof fn.arguments === "string") slot.args += fn.arguments;
            calls.set(index, slot);
          }
          if (typeof choice.finish_reason === "string") {
            stop = STOP[choice.finish_reason] ?? "end";
            if (text) content.push({ type: "text", text });
            for (const [, slot] of [...calls].sort((a, b) => a[0] - b[0])) {
              let input: unknown = {};
              try {
                if (slot.args.trim()) input = JSON.parse(slot.args);
              } catch {
                yield {
                  type: "error",
                  message: `${label} sent malformed arguments for ${slot.name}`,
                };
                return;
              }
              content.push({ type: "call", id: slot.id, name: slot.name, input });
              yield { type: "call", id: slot.id, name: slot.name, input };
            }
            callsEmitted = true;
          }
        }
      } catch (err) {
        if (!isAbort(err, req.signal)) {
          yield endedEarly(label, options.apiKey, err);
          return;
        }
      }
      if (req.signal.aborted) {
        if (!callsEmitted && text) content.push({ type: "text", text });
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
