import { describe, expect, it } from "vitest";
import {
  collectionName,
  QdrantIndex,
  type QdrantLike,
  qdrantIndex,
} from "../../src/memory/qdrant.ts";
import { cosine } from "../../src/memory/vectors.ts";
import { fakeEmbedder } from "../support/fakeEmbedder.ts";

type Payload = Record<string, unknown>;
type Stored = { vector: number[]; payload: Payload };
type Condition = { key: string; match: { value: string | number } };

/** Answers the client calls the index makes from memory, the way a Qdrant server would. */
class FakeQdrant implements QdrantLike {
  readonly collections = new Map<string, { size: number; points: Map<number, Stored> }>();
  readonly calls: string[] = [];
  down = false;

  private check(name: string) {
    this.calls.push(name);
    if (this.down) throw new Error("connect ECONNREFUSED");
  }

  async collectionExists(name: string) {
    this.check("exists");
    return { exists: this.collections.has(name) };
  }

  async createCollection(name: string, opts: { vectors: { size: number; distance: string } }) {
    this.check("create");
    expect(opts.vectors.distance).toBe("Cosine");
    this.collections.set(name, { size: opts.vectors.size, points: new Map() });
    return true;
  }

  async upsert(
    name: string,
    opts: { wait?: boolean; points: { id: number; vector: number[]; payload: Payload }[] },
  ) {
    this.check("upsert");
    const collection = this.collections.get(name);
    if (!collection) throw new Error("Not found: collection");
    for (const point of opts.points) {
      expect(point.vector).toHaveLength(collection.size);
      collection.points.set(point.id, { vector: point.vector, payload: point.payload });
    }
    return { status: "completed" };
  }

  async delete(name: string, opts: { wait?: boolean; points: number[] }) {
    this.check("delete");
    for (const id of opts.points) this.collections.get(name)?.points.delete(id);
    return { status: "completed" };
  }

  async query(
    name: string,
    opts: {
      query: number[];
      filter: { must: Condition[] };
      limit: number;
      score_threshold: number;
    },
  ) {
    this.check("query");
    const collection = this.collections.get(name);
    const points = [...(collection?.points ?? new Map<number, Stored>())]
      .filter(([, p]) => opts.filter.must.every((c) => p.payload[c.key] === c.match.value))
      .map(([id, p]) => ({ id, score: cosine(opts.query, p.vector) }))
      .filter((p) => p.score >= opts.score_threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit);
    return { points };
  }
}

const here = { project: "proj", owner: 1 };

describe("Qdrant index", () => {
  it("names the collection after the index epoch", () => {
    expect(collectionName(null)).toBe("memory");
    expect(collectionName("abc")).toBe("memory-abc");
    expect(collectionName("abc", "text-embedding-3-small")).toBe(
      "memory-abc-text-embedding-3-small",
    );
    expect(collectionName("abc", "Org/Model_V2")).toBe("memory-abc-org-model-v2");
  });

  it("starts empty until the collection exists, then keeps it", async () => {
    const client = new FakeQdrant();
    const index = new QdrantIndex(client, fakeEmbedder(), "memory");
    expect(await index.open()).toBe(false);
    expect(await index.search("billing", here, 10, 0.3)).toEqual([]);
    await index.put(1, "Invoice system runs on Postgres", here);
    expect(client.collections.get("memory")?.size).toBe(384);
    expect(await new QdrantIndex(client, fakeEmbedder(), "memory").open()).toBe(true);
  });

  it("finds by meaning within the person's scope, and removes", async () => {
    const client = new FakeQdrant();
    const index = new QdrantIndex(client, fakeEmbedder(), "memory");
    await index.put(1, "Invoice system runs on Postgres", here);
    await index.put(2, "Their cat is named Juno", here);
    await index.put(3, "Invoice system runs on Postgres", { project: "proj", owner: 2 });
    expect(await index.search("invoice system database", here, 10, 0.3)).toEqual([1]);
    expect(await index.search("weather", here, 10, 0.3)).toEqual([]);
    await index.remove(1);
    expect(await index.search("invoice system database", here, 10, 0.3)).toEqual([]);
    await index.remove(99);
  });

  it("removing before any collection exists does nothing", async () => {
    const client = new FakeQdrant();
    await new QdrantIndex(client, fakeEmbedder(), "memory").remove(5);
    expect(client.calls).toEqual(["exists"]);
  });

  it("a server that is down fails the call so the fact is retried later", async () => {
    const client = new FakeQdrant();
    client.down = true;
    const index = new QdrantIndex(client, fakeEmbedder(), "memory");
    await expect(index.put(1, "Billing", here)).rejects.toThrow("ECONNREFUSED");
  });

  it("builds a real client for a configured server", () => {
    const index = qdrantIndex({ url: "http://localhost:6333", embedder: fakeEmbedder() });
    expect(index).toBeInstanceOf(QdrantIndex);
  });
});
