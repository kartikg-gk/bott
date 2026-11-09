import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelProvider, StreamEvent } from "../agent/providers/types.ts";
import type { Database } from "../db/database.ts";

export interface LimitsConfig {
  /** Model requests one run may send, retries included. */
  requestsPerRun: number;
  /** Model requests the instance may send per UTC day. */
  requestsPerDay: number;
  /** Spend one run may reserve, in millionths of a dollar; null for no limit. */
  spendMicrosPerRun: number | null;
  /** Spend the instance may reserve per UTC day, in millionths of a dollar; null for no limit. */
  spendMicrosPerDay: number | null;
  /** The most one attempt may cost, by "provider/model". Needed for every model once spend is limited. */
  attemptMaxMicros: Record<string, number>;
}

export const DEFAULT_LIMITS: LimitsConfig = {
  requestsPerRun: 100,
  requestsPerDay: 1000,
  spendMicrosPerRun: null,
  spendMicrosPerDay: null,
  attemptMaxMicros: {},
};

const MAX_ATTEMPT_MICROS = 10 ** 12;
const NO_DAILY_SPEND_LIMIT = 2n ** 62n;

/** What one run has used so far, and why it was stopped if it was. */
export class RunBudget {
  requests = 0;
  spendMicros = 0;
  refusal: string | null = null;
}

/** The operation the current code runs in, per instance. */
const operations = new AsyncLocalStorage<{ instance: string; run: RunBudget }>();

/**
 * Daily request and spend limits shared by every process using the database, and per-run
 * limits held in memory. Each daily limit is checked in the same statement that counts
 * against it, so concurrent runs cannot pass it together.
 */
export class ModelLimits {
  readonly config: LimitsConfig;
  private readonly clock: () => number;

  constructor(
    private readonly db: Database,
    readonly instance: string,
    config: Partial<LimitsConfig> = {},
    opts: { clock?: () => number } = {},
  ) {
    this.config = { ...DEFAULT_LIMITS, ...config };
    this.clock = opts.clock ?? (() => Date.now() / 1000);
  }

  /** Spend is reserved per attempt only when a spend limit is set. */
  get spendMetered(): boolean {
    return this.config.spendMicrosPerRun !== null || this.config.spendMicrosPerDay !== null;
  }

  /** Runs `work` as one run with its own budget; metered providers called inside share it. */
  operation<T>(work: (run: RunBudget) => Promise<T>): Promise<T> {
    const run = new RunBudget();
    return operations.run({ instance: this.instance, run }, () => work(run));
  }

  /** The current operation's budget for this instance, or a fresh one outside any operation. */
  scope(): RunBudget {
    const current = operations.getStore();
    return current && current.instance === this.instance ? current.run : new RunBudget();
  }

  private refuse(run: RunBudget, reason: string): never {
    run.refusal = reason;
    throw new Error(reason);
  }

  private today(): string {
    return new Date(this.clock() * 1000).toISOString().slice(0, 10);
  }

  /** Counts one request, and its spend when given, against every limit, or throws why not. */
  async reserve(run: RunBudget, micros?: number): Promise<void> {
    if (run.refusal) throw new Error(run.refusal);
    const config = this.config;
    if (run.requests >= config.requestsPerRun) {
      this.refuse(run, "The request limit for this run is used up.");
    }
    const perRun = config.spendMicrosPerRun;
    if (micros !== undefined && perRun !== null && run.spendMicros + micros > perRun) {
      this.refuse(run, "The spend limit for this run is used up.");
    }
    const day = this.today();
    const counted = await this.db.query(
      "INSERT INTO model_requests(instance,day,count) VALUES(?,?,1) " +
        "ON CONFLICT(instance,day) DO UPDATE SET count=count+1 WHERE count<CAST(? AS INTEGER) " +
        "RETURNING count",
      [this.instance, day, config.requestsPerDay],
    );
    if (counted.length === 0) {
      this.refuse(run, "The daily request limit is used up; it resets at midnight UTC.");
    }
    if (micros !== undefined) {
      const limit =
        config.spendMicrosPerDay === null ? NO_DAILY_SPEND_LIMIT : BigInt(config.spendMicrosPerDay);
      const debited = await this.db.query(
        "INSERT INTO model_spend(instance,day,micros) SELECT ?,?,? " +
          "WHERE CAST(? AS INTEGER)<=CAST(? AS INTEGER) " +
          "ON CONFLICT(instance,day) DO UPDATE SET micros=micros+excluded.micros " +
          "WHERE micros<=CAST(? AS INTEGER)-excluded.micros RETURNING micros",
        [this.instance, day, micros, micros, limit, limit],
      );
      if (debited.length === 0) {
        // A refused request is not counted, as if both had been one transaction.
        await this.db.run("UPDATE model_requests SET count=count-1 WHERE instance=? AND day=?", [
          this.instance,
          day,
        ]);
        this.refuse(run, "The daily spend limit is used up; it resets at midnight UTC.");
      }
    }
    run.requests += 1;
    run.spendMicros += micros ?? 0;
  }

  /** Reserves one attempt at the model's approved maximum charge. */
  async reserveAttempt(run: RunBudget, provider: string, model: string): Promise<void> {
    if (run.refusal) throw new Error(run.refusal);
    const maximum = Object.hasOwn(this.config.attemptMaxMicros, `${provider}/${model}`)
      ? this.config.attemptMaxMicros[`${provider}/${model}`]
      : undefined;
    if (
      !Number.isInteger(maximum) ||
      (maximum as number) < 0 ||
      (maximum as number) > MAX_ATTEMPT_MICROS
    ) {
      this.refuse(run, "This model has no approved spending cap set.");
    }
    await this.reserve(run, maximum);
  }

  /**
   * The provider with every attempt counted: the first before anything is sent, and each retry
   * before it is sent. With a spend limit, each attempt also reserves its maximum charge.
   */
  meter(provider: ModelProvider, name: string): ModelProvider {
    return {
      id: provider.id,
      stream: (req) => {
        const limits = this;
        return (async function* (): AsyncGenerator<StreamEvent> {
          const run = limits.scope();
          const attempt = () =>
            limits.spendMetered ? limits.reserveAttempt(run, name, req.model) : limits.reserve(run);
          await attempt();
          for await (const event of provider.stream(req)) {
            if (event.type === "retry") await attempt();
            yield event;
          }
        })();
      },
    };
  }
}
