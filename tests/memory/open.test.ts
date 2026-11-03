import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.ts";
import { readMemoryConfig } from "../../src/memory/config.ts";
import { memoryIndex, openMemory } from "../../src/memory/open.ts";
import { QdrantIndex } from "../../src/memory/qdrant.ts";
import { CosineIndex } from "../../src/memory/vectors.ts";
import { Store } from "../../src/store/store.ts";
import { database } from "../support/fakeD1.ts";
import { fakeEmbedder } from "../support/fakeEmbedder.ts";

describe("opening memory from the settings", () => {
  const open: Database[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function store() {
    const { db } = database("sqlite");
    open.push(db);
    return Store.open(db, "main");
  }

  it("is null while memory is off", async () => {
    expect(await openMemory(await store(), readMemoryConfig({}), {})).toBeNull();
  });

  it("uses the in-process index and the settings' recall limits", async () => {
    const config = readMemoryConfig({ enabled: true, searchLimit: 4, tokenBudget: 300 });
    const memory = await openMemory(await store(), config, {}, { embedder: fakeEmbedder() });
    expect(memory?.index).toBeInstanceOf(CosineIndex);
    expect(memory).toMatchObject({ limit: 4, floor: 0.3, budget: 300 });
  });

  it("needs an embeddings key unless an embedder is given", async () => {
    const config = readMemoryConfig({ enabled: true });
    await expect(openMemory(await store(), config, {})).rejects.toThrow("OPENAI_API_KEY");
  });

  it("uses Qdrant when a server is configured, in the epoch's collection", () => {
    const config = readMemoryConfig({ enabled: true, qdrantUrl: "http://localhost:6333" });
    const index = memoryIndex(config, fakeEmbedder(), "abc", {});
    expect(index).toBeInstanceOf(QdrantIndex);
    expect((index as unknown as { collection: string }).collection).toBe(
      "memory-abc-text-embedding-3-small",
    );
    expect(memoryIndex(readMemoryConfig({}), fakeEmbedder(), null, {})).toBeInstanceOf(CosineIndex);
  });
});
