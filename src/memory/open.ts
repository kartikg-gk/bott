import type { Store } from "../store/store.js";
import type { MemoryConfig } from "./config.js";
import { FactStore } from "./facts.js";
import { Memory } from "./memory.js";
import { qdrantIndex } from "./qdrant.js";
import { CosineIndex, type Embedder, embeddingsEmbedder, type VectorIndex } from "./vectors.js";

type Env = Record<string, string | undefined>;

/** The index the settings ask for: a Qdrant server when one is set, else one in this process. */
export function memoryIndex(
  config: MemoryConfig,
  embedder: Embedder,
  epoch: string | null,
  env: Env,
): VectorIndex {
  if (!config.qdrantUrl) return new CosineIndex(embedder);
  return qdrantIndex({ url: config.qdrantUrl, apiKey: env.QDRANT_API_KEY, embedder, epoch });
}

/** Opens long-term memory as the settings describe, or returns null while it is off. */
export async function openMemory(
  store: Store,
  config: MemoryConfig,
  env: Env = process.env,
  opts: { embedder?: Embedder } = {},
): Promise<Memory | null> {
  if (!config.enabled) return null;
  const embedder =
    opts.embedder ??
    embeddingsEmbedder({
      apiKey: env.OPENAI_API_KEY,
      model: config.embeddingModel,
      baseUrl: env.OPENAI_BASE_URL,
    });
  const epoch = await new FactStore(store.ctx).epoch();
  return Memory.open(store.ctx, memoryIndex(config, embedder, epoch, env), {
    limit: config.searchLimit,
    floor: config.searchFloor,
    budget: config.tokenBudget,
  });
}
