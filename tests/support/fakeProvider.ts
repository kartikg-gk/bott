import type {
  ModelProvider,
  ProviderRequest,
  StreamEvent,
} from "../../src/agent/providers/types.ts";

export interface FakeProvider extends ModelProvider {
  requests: ProviderRequest[];
}

/** Plays one scripted reply per stream call. */
export function fakeProvider(script: StreamEvent[][]): FakeProvider {
  const requests: ProviderRequest[] = [];
  let next = 0;
  return {
    id: "fake",
    requests,
    async *stream(req) {
      requests.push(req);
      const reply = script[next++];
      if (!reply) throw new Error(`fakeProvider: no scripted reply for call ${next}`);
      for (const event of reply) yield event;
    },
  };
}
