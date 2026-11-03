import type { Scope } from "./facts.js";

/** Turns text into vectors; one vector per text, in order. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/** The search index over current facts. It is only ever a copy of the database. */
export interface VectorIndex {
  /** Prepares the index. False when it starts empty and must be filled from the database. */
  open(): Promise<boolean>;
  put(id: number, text: string, scope: Scope): Promise<void>;
  remove(id: number): Promise<void>;
  /** Fact numbers at least `floor` similar to the text, best first. */
  search(text: string, scope: Scope, limit: number, floor: number): Promise<number[]>;
  close(): Promise<void>;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  return left === 0 || right === 0 ? 0 : dot / Math.sqrt(left * right);
}

interface Point {
  vector: number[];
  project: string;
  owner: number;
}

/** An index held in this process. It starts empty each time and is filled from the database. */
export class CosineIndex implements VectorIndex {
  private readonly points = new Map<number, Point>();

  constructor(private readonly embedder: Embedder) {}

  async open(): Promise<boolean> {
    return this.points.size > 0;
  }

  async put(id: number, text: string, scope: Scope): Promise<void> {
    const [vector] = await this.embedder.embed([text]);
    if (!vector) throw new Error("The embedder returned no vector");
    this.points.set(id, { vector, project: scope.project, owner: scope.owner });
  }

  async remove(id: number): Promise<void> {
    this.points.delete(id);
  }

  async search(text: string, scope: Scope, limit: number, floor: number): Promise<number[]> {
    if (this.points.size === 0) return [];
    const [query] = await this.embedder.embed([text]);
    if (!query) return [];
    const scored: [number, number][] = [];
    for (const [id, point] of this.points) {
      if (point.project !== scope.project || point.owner !== scope.owner) continue;
      const score = cosine(query, point.vector);
      if (score >= floor) scored.push([id, score]);
    }
    scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return scored.slice(0, limit).map(([id]) => id);
  }

  async close(): Promise<void> {
    this.points.clear();
  }
}

const EMBED_TIMEOUT_MS = 30_000;

/**
 * Vectors from an OpenAI-style `/embeddings` endpoint. The key is sent only in the
 * Authorization header and never appears in an error.
 */
export function embeddingsEmbedder(opts: {
  apiKey: string | undefined;
  model: string;
  baseUrl?: string | undefined;
  fetch?: typeof fetch;
}): Embedder {
  if (!opts.apiKey) throw new Error("Memory needs OPENAI_API_KEY for embeddings");
  const url = `${(opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/embeddings`;
  const send = opts.fetch ?? fetch;
  return {
    async embed(texts) {
      let response: Response;
      try {
        response = await send(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: opts.model, input: texts }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(`Embedding request failed: ${(error as Error).name}`);
      }
      if (!response.ok) throw new Error(`Embedding request failed (HTTP ${response.status})`);
      const payload = (await response.json().catch(() => null)) as {
        data?: { index?: unknown; embedding?: unknown }[];
      } | null;
      const data = Array.isArray(payload?.data) ? payload.data : [];
      const vectors: number[][] = [];
      for (const item of data) {
        if (typeof item.index === "number" && Array.isArray(item.embedding)) {
          vectors[item.index] = item.embedding.map(Number);
        }
      }
      const ordered = texts.map((_, i) => vectors[i]);
      if (vectors.length !== texts.length || ordered.some((v) => v === undefined)) {
        throw new Error("Embedding request failed: the response was not understood");
      }
      return ordered as number[][];
    },
  };
}
