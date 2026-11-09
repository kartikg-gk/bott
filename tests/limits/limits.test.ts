import { afterEach, describe, expect, it } from "vitest";
import { withRetry } from "../../src/agent/providers/retry.ts";
import type {
  ModelProvider,
  ProviderRequest,
  StreamEvent,
} from "../../src/agent/providers/types.ts";
import type { Database } from "../../src/db/database.ts";
import { ensureSchema } from "../../src/db/schema.ts";
import { type LimitsConfig, ModelLimits, RunBudget } from "../../src/limits/limits.ts";
import { RunUsage } from "../../src/limits/usage.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

const DAY = 86_400;
const START = Date.UTC(2026, 10, 9, 12) / 1000;

const request = (model = "mock"): ProviderRequest => ({
  model,
  system: "",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  signal: new AbortController().signal,
});

const reply: StreamEvent = {
  type: "end",
  entry: {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: "mock",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    stop: "end",
  },
};

/** Counts every attempt it is asked to send; fails with a rate limit `failures` times first. */
function counting(failures = 0): ModelProvider & { attempts: string[] } {
  const attempts: string[] = [];
  let left = failures;
  return {
    id: "openai",
    attempts,
    async *stream(req) {
      attempts.push(req.model);
      if (left-- > 0) {
        yield { type: "error", message: "slow down", status: 429, retryable: true };
        return;
      }
      yield reply;
    },
  };
}

async function drain(provider: ModelProvider, req = request()): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(req)) events.push(event);
  return events;
}

const noSleep = async () => {};

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  let now = START;
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function fresh(): Promise<Database> {
    const { db } = database(kind);
    open.push(db);
    await ensureSchema(db);
    now = START;
    return db;
  }

  const limits = (db: Database, config: Partial<LimitsConfig>, instance = "main") =>
    new ModelLimits(db, instance, config, { clock: () => now });

  async function counts(db: Database) {
    const requests = await db.query("SELECT instance, day, count FROM model_requests ORDER BY 1");
    const spend = await db.query("SELECT instance, day, micros FROM model_spend ORDER BY 1");
    return {
      requests: requests.map((r) => [r.instance, r.day, Number(r.count)]),
      spend: spend.map((r) => [r.instance, r.day, Number(r.micros)]),
    };
  }

  it("stops a run at its request limit and lets the next run start fresh", async () => {
    const db = await fresh();
    const model = limits(db, { requestsPerRun: 1 });
    const provider = model.meter(counting(), "openai");
    await model.operation(async () => {
      expect((await drain(provider)).at(-1)).toEqual(reply);
      await expect(drain(provider)).rejects.toThrow("The request limit for this run is used up.");
      // The refusal sticks for the rest of the run.
      await expect(drain(provider)).rejects.toThrow("The request limit for this run is used up.");
    });
    await model.operation(async () => {
      expect((await drain(provider)).at(-1)).toEqual(reply);
    });
    expect((await counts(db)).requests).toEqual([["main", "2026-11-09", 2]]);
  });

  it("keeps the daily request count in the database, per instance and per UTC day", async () => {
    const db = await fresh();
    for (const expected of [true, false]) {
      const model = limits(db, { requestsPerDay: 1 });
      const run = model.operation(() => drain(model.meter(counting(), "openai")));
      if (expected) await run;
      else
        await expect(run).rejects.toThrow(
          "The daily request limit is used up; it resets at midnight UTC.",
        );
    }
    await limits(db, { requestsPerDay: 1 }, "other").operation(() =>
      drain(limits(db, { requestsPerDay: 1 }, "other").meter(counting(), "openai")),
    );
    now += DAY;
    const model = limits(db, { requestsPerDay: 1 });
    await model.operation(() => drain(model.meter(counting(), "openai")));
    expect((await counts(db)).requests).toEqual([
      ["main", "2026-11-09", 1],
      ["main", "2026-11-10", 1],
      ["other", "2026-11-09", 1],
    ]);
  });

  it("counts a retried request again", async () => {
    const db = await fresh();
    const model = limits(db, {});
    const inner = counting(2);
    const provider = model.meter(
      withRetry(inner, { attempts: 4, baseMs: 1, sleep: noSleep }),
      "openai",
    );
    await model.operation(async (run) => {
      await drain(provider);
      expect(run.requests).toBe(3);
    });
    expect(inner.attempts).toHaveLength(3);
    expect((await counts(db)).requests).toEqual([["main", "2026-11-09", 3]]);
  });

  it("charges each attempt its approved maximum and keeps the daily total across restarts", async () => {
    const db = await fresh();
    const config = { spendMicrosPerDay: 900, attemptMaxMicros: { "openai/mock": 600 } };
    const sent: string[] = [];
    for (let i = 0; i < 2; i++) {
      const model = limits(db, config);
      const inner = counting(5);
      const provider = model.meter(
        withRetry(inner, { attempts: 3, baseMs: 1, sleep: noSleep }),
        "openai",
      );
      await expect(model.operation(() => drain(provider))).rejects.toThrow(
        "The daily spend limit is used up; it resets at midnight UTC.",
      );
      sent.push(...inner.attempts);
    }
    expect(sent).toEqual(["mock"]);
    expect(await counts(db)).toEqual({
      requests: [["main", "2026-11-09", 1]],
      spend: [["main", "2026-11-09", 600]],
    });
  });

  it("stops a run at its spend limit before sending", async () => {
    const db = await fresh();
    const model = limits(db, { spendMicrosPerRun: 1000, attemptMaxMicros: { "openai/mock": 600 } });
    const inner = counting();
    const provider = model.meter(inner, "openai");
    await model.operation(async (run) => {
      await drain(provider);
      await expect(drain(provider)).rejects.toThrow("The spend limit for this run is used up.");
      expect(run).toMatchObject({ requests: 1, spendMicros: 600 });
    });
    expect(inner.attempts).toHaveLength(1);
  });

  it("refuses to send to a model without an approved maximum charge", async () => {
    const db = await fresh();
    const model = limits(db, { spendMicrosPerRun: 1000, attemptMaxMicros: { "openai/mock": 600 } });
    const inner = counting();
    await expect(
      model.operation(() => drain(model.meter(inner, "openai"), request("unknown"))),
    ).rejects.toThrow("This model has no approved spending cap set.");
    await expect(model.operation(() => drain(model.meter(inner, "anthropic")))).rejects.toThrow(
      "This model has no approved spending cap set.",
    );
    expect(inner.attempts).toEqual([]);
    expect(await counts(db)).toEqual({ requests: [], spend: [] });
  });

  it("does not charge spend when no spend limit is set", async () => {
    const db = await fresh();
    const model = limits(db, { attemptMaxMicros: { "openai/mock": 600 } });
    await model.operation(() => drain(model.meter(counting(), "openai")));
    expect(await counts(db)).toEqual({ requests: [["main", "2026-11-09", 1]], spend: [] });
  });

  it("shares one budget between calls in the same operation and instance only", async () => {
    const db = await fresh();
    const main = limits(db, { requestsPerRun: 2 });
    const other = limits(db, { requestsPerRun: 2 }, "other");
    await main.operation(async (run) => {
      expect(main.scope()).toBe(run);
      expect(other.scope()).not.toBe(run);
      await main.reserve(main.scope());
      await main.reserve(main.scope());
      await expect(main.reserve(main.scope())).rejects.toThrow("for this run");
    });
    expect(main.scope()).toBeInstanceOf(RunBudget);
  });
});

describe("run usage", () => {
  it("adds up what the provider counted for each finished model message", () => {
    const usage = new RunUsage();
    usage.observe({ type: "message_start" });
    usage.observe({
      type: "message_end",
      message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 } },
    });
    usage.observe({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 3, output: -1, cacheRead: 1.5, cost: { total: 0.25 } },
      },
    });
    usage.observe({ type: "message_end", message: { role: "user", usage: { input: 99 } } });
    usage.observe({ type: "message_end", message: { role: "assistant" } });
    usage.observe({
      type: "message_end",
      message: { role: "assistant", usage: { cost: { total: Number.POSITIVE_INFINITY } } },
    });
    expect(usage.result()).toEqual({
      input: 13,
      output: 5,
      cache_read: 2,
      cache_write: 1,
      model_messages: 3,
      cost_usd: 0.25,
    });
  });
});
