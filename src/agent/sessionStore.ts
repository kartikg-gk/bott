import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEntry } from "./transcript.ts";

export interface SessionStore {
  load(id: string): Promise<TranscriptEntry[]>;
  append(id: string, entries: TranscriptEntry[]): Promise<void>;
  /** Replaces the whole transcript, as after compaction. */
  replace(id: string, entries: TranscriptEntry[]): Promise<void>;
}

/** One line per record: `{ entry }` appends, `{ reset }` replaces everything before it. */
type Line = { entry: TranscriptEntry } | { reset: TranscriptEntry[] };

export function jsonlSessionStore(dir: string): SessionStore {
  const file = (id: string) => join(dir, `${id}.jsonl`);
  const write = async (id: string, lines: Line[]) => {
    await mkdir(dir, { recursive: true });
    await dropTornTail(file(id));
    await appendFile(file(id), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  };
  return {
    async load(id) {
      let text: string;
      try {
        text = await readFile(file(id), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const lines = text.split("\n");
      const last = lines.length - 1;
      let entries: TranscriptEntry[] = [];
      for (const [i, raw] of lines.entries()) {
        if (!raw.trim()) continue;
        let line: Line;
        try {
          line = JSON.parse(raw) as Line;
        } catch {
          // A crash mid-write leaves one torn final line; anything else is corruption.
          if (i === last) break;
          throw new Error(`Session ${id} is corrupt at line ${i + 1}.`);
        }
        if ("reset" in line) entries = [...line.reset];
        else entries.push(line.entry);
      }
      return entries;
    },
    append: (id, entries) =>
      write(
        id,
        entries.map((entry) => ({ entry })),
      ),
    replace: (id, entries) => write(id, [{ reset: entries }]),
  };
}

/** Keeps transcripts in memory, seeded with earlier messages (hosted runs). */
export function memorySessionStore(seed: Record<string, TranscriptEntry[]> = {}): SessionStore {
  const data = new Map(Object.entries(seed).map(([id, e]) => [id, [...e]]));
  return {
    async load(id) {
      return [...(data.get(id) ?? [])];
    },
    async append(id, entries) {
      data.set(id, [...(data.get(id) ?? []), ...entries]);
    },
    async replace(id, entries) {
      data.set(id, [...entries]);
    },
  };
}

/** Cuts a torn final line (left by a crash mid-write) so the next append starts clean. */
async function dropTornTail(path: string): Promise<void> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (data.length === 0 || data[data.length - 1] === 0x0a) return;
  await truncate(path, data.lastIndexOf(0x0a) + 1);
}
