import { createHash } from "node:crypto";
import type { Embedder } from "../../src/memory/vectors.ts";

const SIZE = 384;

/** Words of three letters or more hashed into 384 slots: shared words mean similar vectors. */
export function wordVector(text: string): number[] {
  const vector = new Array<number>(SIZE).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    const slot = Number(BigInt(`0x${createHash("sha256").update(word).digest("hex")}`) % 384n);
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

export function fakeEmbedder(): Embedder & { calls: number } {
  const embedder = {
    calls: 0,
    async embed(texts: string[]): Promise<number[][]> {
      embedder.calls++;
      return texts.map(wordVector);
    },
  };
  return embedder;
}
