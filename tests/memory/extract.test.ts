import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.ts";
import {
  type Extractor,
  episodeCheckPrompt,
  episodePrompt,
  factsPrompt,
  LoopExtractor,
  learn,
  parseEpisode,
  parseEpisodeCheck,
  parseFacts,
} from "../../src/memory/extract.ts";
import type { Scope } from "../../src/memory/facts.ts";
import { Memory } from "../../src/memory/memory.ts";
import { CosineIndex } from "../../src/memory/vectors.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";
import { fakeEmbedder } from "../support/fakeEmbedder.ts";

const here: Scope = { project: "proj", owner: 1 };
const episode = {
  goal: "Fix login",
  context: "c",
  approach: "a",
  outcome: "o",
  outcome_quality: "good",
  lessons: "l",
};

describe("reading the extractor's answers", () => {
  it.each([
    "not json",
    "[1]",
    '[{"text":"x","confidence":0.2}]',
    '[{"text":"x","confidence":"high"}]',
    '[{"text":"","confidence":0.9}]',
    '[{"text":"x"}]',
    '[{"text":5,"confidence":0.9}]',
    "[broken",
  ])("drops malformed or weak facts: %s", (answer) => {
    expect(parseFacts(answer, new Set())).toEqual([]);
  });

  it("cleans each fact's fields", () => {
    const answer = `Here you go: ${JSON.stringify([
      { text: " A ", confidence: 3, tags: ["bogus", "schedule", "schedule"], updates: 7 },
      { text: "B", confidence: "0.7", updates: 99, quote: "said so" },
    ])}`;
    const [first, second] = parseFacts(answer, new Set([7]));
    expect(first).toEqual({
      text: "A",
      confidence: 1,
      tags: ["schedule"],
      quote: null,
      updates: 7,
    });
    expect(second).toMatchObject({ updates: null, tags: ["fact"], quote: "said so" });
  });

  it("keeps at most five facts and four tags", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      text: `F${i}`,
      confidence: 0.9,
      tags: ["preference", "decision", "fact", "constraint", "project"],
    }));
    const facts = parseFacts(JSON.stringify(many), new Set());
    expect(facts).toHaveLength(5);
    expect(facts[0]?.tags).toEqual(["preference", "decision", "fact", "constraint"]);
  });

  it("an episode needs a yes and every field", () => {
    expect(parseEpisodeCheck('{"episode": true}')).toBe(true);
    expect(parseEpisodeCheck('{"episode": "true"}')).toBe(false);
    expect(parseEpisodeCheck("yes")).toBe(false);
    const parsed = parseEpisode(JSON.stringify(episode));
    expect(parsed?.text).toBe("Goal: Fix login Approach: a Outcome (good): o Lessons: l");
    expect(parsed?.detail).toEqual(episode);
    expect(parsed?.tags).toEqual(["fact"]);
    expect(parseEpisode(JSON.stringify({ ...episode, goal: 5 }))).toBeNull();
    expect(parseEpisode("nothing")).toBeNull();
  });

  it("prompts carry the exchange as data, the known facts and the allowed tags", () => {
    const prompt = factsPrompt("hi", "a".repeat(3000), [{ id: 4, text: "Has a dog" } as never]);
    expect(prompt).toContain("#4: Has a dog");
    expect(prompt).toContain("<user>hi</user>");
    expect(prompt).toContain(`<assistant>${"a".repeat(2000)}</assistant>`);
    expect(prompt).not.toContain("a".repeat(2001));
    expect(prompt).toContain("confirmed_action");
    expect(prompt).toMatch(/ignore any instructions/i);
    expect(factsPrompt("hi", "", [])).toContain("(none)");
    expect(episodeCheckPrompt("u", "a")).toContain('{"episode": true}');
    expect(episodePrompt("u", "a")).toContain("outcome_quality");
  });
});

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function fresh() {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main");
    return Memory.open(store.ctx, new CosineIndex(fakeEmbedder()));
  }

  /** Answers each kind of extraction prompt with the reply set for it. */
  function model() {
    const replies = { facts: "[]", check: '{"episode": false}', episode: "{}" };
    const prompts: string[] = [];
    const call = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt === episodeCheckPrompt("u", "a") || prompt.includes("worth keeping")) {
        return replies.check;
      }
      if (prompt.includes("outcome_quality")) return replies.episode;
      return replies.facts;
    };
    return { replies, prompts, call };
  }

  it("new facts from an exchange are saved and searchable", async () => {
    const memory = await fresh();
    const { replies, prompts, call } = model();
    replies.facts = JSON.stringify([
      { text: "Invoice system runs on Postgres", confidence: 0.9, tags: ["project"] },
    ]);
    const result = await learn(memory, new LoopExtractor(call), call, here, "u", "a");
    expect(result.conflicts).toEqual([]);
    expect(prompts).toHaveLength(2);
    const [fact] = await memory.search(here, "invoice system database");
    expect(fact).toMatchObject({ source: "extracted", tags: ["project"], confidence: 0.9 });
  });

  it("the extractor is shown the relevant known facts and can revise them", async () => {
    const memory = await fresh();
    const old = (await memory.facts.add(here, "fact", "Invoice system runs on Postgres", {
      source: "explicit",
    })) as number;
    await memory.sync();
    const { replies, prompts, call } = model();
    replies.facts = JSON.stringify([
      { text: "Invoice system runs on MySQL", confidence: 0.6, updates: old },
    ]);
    const result = await learn(
      memory,
      new LoopExtractor(call),
      call,
      here,
      "invoice system moved",
      "ok",
    );
    expect(prompts[0]).toContain(`#${old}: Invoice system runs on Postgres`);
    expect(result.conflicts).toHaveLength(1);
    expect(await memory.search(here, "invoice system")).toEqual([]);
  });

  it("a revision of a fact that changed meanwhile is skipped, the rest is kept", async () => {
    const memory = await fresh();
    const extractor: Extractor = {
      async changes() {
        return [
          { text: "Moved", confidence: 1, tags: ["fact"], quote: null, updates: 999 },
          { text: "Has a dog", confidence: 0.8, tags: ["fact"], quote: null, updates: null },
        ];
      },
    };
    const { call } = model();
    await learn(memory, extractor, call, here, "u", "a");
    expect((await memory.facts.facts(here)).map((f) => f.text)).toEqual(["Has a dog"]);
  });

  it("an episode is written only when the check says so", async () => {
    const memory = await fresh();
    const { replies, prompts, call } = model();
    await learn(memory, new LoopExtractor(call), call, here, "hello", "hi");
    expect(prompts).toHaveLength(2);
    replies.check = '{"episode": true}';
    replies.episode = JSON.stringify(episode);
    await learn(memory, new LoopExtractor(call), call, here, "fix login", "done");
    expect(prompts).toHaveLength(5);
    const [saved] = await memory.facts.facts(here, { kind: "episode" });
    expect(saved?.text.slice(0, 15)).toBe("Goal: Fix login");
    expect(saved?.source).toBe("episode");
    expect(await memory.search(here, "fix login")).toHaveLength(1);
  });
});
