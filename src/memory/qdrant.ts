import { QdrantClient } from "@qdrant/js-client-rest";
import type { Scope } from "./facts.js";
import type { Embedder, VectorIndex } from "./vectors.js";

/** Longest one request to the Qdrant server may take. */
const QDRANT_TIMEOUT_MS = 10_000;

/** The client calls the index makes, so tests can answer them without a server. */
export interface QdrantLike {
  collectionExists(name: string): Promise<{ exists: boolean }>;
  createCollection(
    name: string,
    opts: { vectors: { size: number; distance: "Cosine" } },
  ): Promise<unknown>;
  upsert(
    name: string,
    opts: {
      wait: boolean;
      points: { id: number; vector: number[]; payload: Record<string, unknown> }[];
    },
  ): Promise<unknown>;
  delete(name: string, opts: { wait: boolean; points: number[] }): Promise<unknown>;
  query(
    name: string,
    opts: {
      query: number[];
      filter: { must: { key: string; match: { value: string | number } }[] };
      limit: number;
      score_threshold: number;
      with_payload: boolean;
    },
  ): Promise<{ points: { id: string | number }[] }>;
}

/**
 * One collection per database generation and embedding model: two databases on one server, or
 * vectors from two models, never land in the same collection.
 */
export function collectionName(epoch: string | null, model?: string): string {
  const base = epoch ? `memory-${epoch}` : "memory";
  const slug = (model ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `${base}-${slug}` : base;
}

/** The search index on a Qdrant server, for facts that should outlive this process's index. */
export class QdrantIndex implements VectorIndex {
  private ready = false;

  constructor(
    private readonly client: QdrantLike,
    private readonly embedder: Embedder,
    private readonly collection: string,
  ) {}

  async open(): Promise<boolean> {
    this.ready = (await this.client.collectionExists(this.collection)).exists;
    return this.ready;
  }

  async put(id: number, text: string, scope: Scope): Promise<void> {
    const [vector] = await this.embedder.embed([text]);
    if (!vector) throw new Error("The embedder returned no vector");
    await this.prepare(vector.length);
    await this.client.upsert(this.collection, {
      wait: true,
      points: [{ id, vector, payload: { project: scope.project, owner: scope.owner } }],
    });
  }

  async remove(id: number): Promise<void> {
    if (!(await this.exists())) return;
    await this.client.delete(this.collection, { wait: true, points: [id] });
  }

  async search(text: string, scope: Scope, limit: number, floor: number): Promise<number[]> {
    if (!(await this.exists())) return [];
    const [query] = await this.embedder.embed([text]);
    if (!query) return [];
    const found = await this.client.query(this.collection, {
      query,
      filter: {
        must: [
          { key: "project", match: { value: scope.project } },
          { key: "owner", match: { value: scope.owner } },
        ],
      },
      limit,
      score_threshold: floor,
      with_payload: false,
    });
    return found.points.map((point) => Number(point.id));
  }

  async close(): Promise<void> {}

  private async exists(): Promise<boolean> {
    if (!this.ready) this.ready = (await this.client.collectionExists(this.collection)).exists;
    return this.ready;
  }

  private async prepare(size: number): Promise<void> {
    if (await this.exists()) return;
    try {
      await this.client.createCollection(this.collection, {
        vectors: { size, distance: "Cosine" },
      });
    } catch (error) {
      // Another process may have made it first.
      if (!(await this.client.collectionExists(this.collection)).exists) throw error;
    }
    this.ready = true;
  }
}

/** An index on the Qdrant server at `url`; the key, when set, goes only to that server. */
export function qdrantIndex(opts: {
  url: string;
  apiKey?: string | undefined;
  embedder: Embedder;
  epoch?: string | null;
  model?: string;
}): QdrantIndex {
  const client = new QdrantClient({
    url: opts.url,
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    checkCompatibility: false,
    timeout: QDRANT_TIMEOUT_MS,
  });
  return new QdrantIndex(client, opts.embedder, collectionName(opts.epoch ?? null, opts.model));
}
