import { type App, envSet } from "../../src/apps/app.ts";
import { jsonOutput, request } from "../../src/apps/http.ts";
import { text, tool } from "../../src/apps/schema.ts";

/** A small app against a fake service, so the registry can be tested on its own. */
export const notes: App = {
  name: "notes",
  tools: [
    tool("notes_read", "Read a note.", { id: text }),
    tool("notes_write", "Change a note.", { id: text, body: text }, { write: true }),
    tool("notes_send", "Send a note.", { id: text }, { write: true, review: true }),
  ],
  configured: (env) => envSet(env, "NOTES_KEY"),
  retryOnRefusal: true,
  async run(ctx, name, args) {
    const token = ctx.accounts ? await ctx.token() : String(ctx.env.NOTES_KEY);
    const data = await request(ctx.fetch, "GET", `https://notes.test/${name}/${args.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return jsonOutput({ data, bot: ctx.botName });
  },
};
