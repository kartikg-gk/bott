import { z } from "zod";

const settings = z.object({
  /** Recall from long-term memory before each private message. */
  enabled: z.boolean().default(false),
  /** Learn facts and episodes from each finished exchange. */
  extract: z.boolean().default(false),
  /** Most facts one search returns. */
  searchLimit: z.number().int().min(1).max(50).default(10),
  /** Least similarity a fact needs to be recalled. */
  searchFloor: z.number().min(0).max(1).default(0.3),
  /** Most tokens the recalled block may take, counted as four characters each. */
  tokenBudget: z.number().int().min(100).default(2000),
  /** Longest one extraction call may take. */
  extractionSeconds: z.number().positive().default(120),
  /** A Qdrant server for the search index; without one the index lives in this process. */
  qdrantUrl: z.string().url().nullable().default(null),
  /** The embedding model asked for vectors. */
  embeddingModel: z.string().min(1).default("text-embedding-3-small"),
});

export type MemoryConfig = z.infer<typeof settings>;

/** Reads the `memory` section of the settings. Hosted installs keep notes only. */
export function readMemoryConfig(raw: unknown, opts: { hosted?: boolean } = {}): MemoryConfig {
  const config = settings.parse(raw ?? {});
  if (opts.hosted && config.enabled) {
    throw new Error("Hosted setups keep notes only; switch memory off");
  }
  return config;
}
