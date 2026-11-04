// Throwaway check: what does Mem0's Node SDK report when a stored fact changes?
// Not imported by src/. Run with: OPENAI_API_KEY=... npm run mem0:check
import { Memory } from "mem0ai/oss";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error(
    "OPENAI_API_KEY is not set. Mem0's OSS embedder needs an OpenAI key; export it and rerun.",
  );
  process.exit(1);
}

const memory = new Memory({
  version: "v1.1",
  embedder: { provider: "openai", config: { apiKey, model: "text-embedding-3-small" } },
  vectorStore: { provider: "memory", config: { collectionName: "check", dimension: 1536 } },
  llm: { provider: "openai", config: { apiKey, model: "gpt-5-mini" } },
  historyStore: { provider: "memory", config: {} },
});

const owner = { userId: "check" };
const first = await memory.add("I live in Pune", owner);
console.log("first add():", JSON.stringify(first, null, 2));
const second = await memory.add("I moved to Bengaluru", owner);
console.log("second add():", JSON.stringify(second, null, 2));

const changed = second.results.find((item) => {
  const event = (item as { event?: unknown }).event ?? item.metadata?.event;
  return event === "UPDATE" || event === "DELETE";
});
if (changed) {
  const event = (changed as { event?: unknown }).event ?? changed.metadata?.event;
  console.log(
    `VERDICT: yes, ${String(event)} reported, id=${changed.id}, text=${JSON.stringify(changed.memory)}`,
  );
} else {
  console.log("VERDICT: no UPDATE or DELETE entry in the second result");
}
