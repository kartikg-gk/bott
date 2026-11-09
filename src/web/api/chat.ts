import { HttpError } from "../../accounts/http.ts";
import { WEB_CHAT } from "../../store/store.ts";
import { Queue } from "../channel.ts";
import type { ApiRouter, Ctx } from "../context.ts";
import { fresh, readObject } from "../router.ts";
import { eventStream } from "../sse.ts";

/** The longest message the page may send. */
export const MAX_TEXT = 16_000;
/** How often an idle live stream says it is still there, in milliseconds. */
const KEEP_ALIVE_MS = 15_000;

/** The trimmed message text from a body, or a 400. */
export function messageText(body: Record<string, unknown>): string {
  const text = body.text;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) {
    throw new HttpError(400, `Send between 1 and ${MAX_TEXT} characters of text`);
  }
  return text.trim();
}

/** Whether text is a prompt rather than a control name; skill calls are prompts. */
export function isPrompt(text: string): boolean {
  return !text.startsWith("/") || text.startsWith("/skill:");
}

async function history(ctx: Ctx): Promise<Response> {
  return fresh(await ctx.gateway.store.history(WEB_CHAT, ctx.actor));
}

async function post(ctx: Ctx, request: Request): Promise<Response> {
  const body = await readObject(request, "Send a JSON object with text");
  const text = messageText(body);
  const { gateway } = ctx;
  if (!isPrompt(text)) {
    // Control names are answered by the dispatcher, outside any run.
    const item = await gateway.store.admitWeb(WEB_CHAT, ctx.actor, text);
    await gateway.dispatch();
    return fresh({ id: item.id.toString(), run: null }, 202);
  }
  await gateway.requireModel(ctx.account);
  const route = await gateway.journal.route(ctx.actor, null);
  const { run, inbox } = await gateway.queueRun(route, text, body.conversation);
  await gateway.dispatch();
  return fresh({ id: inbox.toString(), run }, 202);
}

async function decide(ctx: Ctx, request: Request): Promise<Response> {
  const body = await readObject(request, "Send an approval and a decision");
  // Older pages send the button's data, "a:<id>"; the id is what follows the colon.
  const raw = typeof body.id === "string" ? body.id : body.data;
  if (typeof raw !== "string" || typeof body.allow !== "boolean") {
    throw new HttpError(400, "Send the approval's id and allow as true or false");
  }
  const id = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  const decided = await ctx.gateway.dispatcher.decide(id, body.allow, ctx.actor);
  return fresh({ decided }, decided ? 200 : 404);
}

async function tasks(ctx: Ctx): Promise<Response> {
  const { store } = ctx.gateway;
  const rows = [];
  for (const task of await store.tasks()) {
    const bot = await store.bot(task.bot);
    rows.push({
      id: task.id,
      status: task.status,
      goal: task.goal.slice(0, 200),
      bot: bot?.name ?? "-",
    });
  }
  return fresh(rows);
}

/** The page's live stream: answers, tool activity and approvals on the main conversation. */
async function stream(ctx: Ctx): Promise<Response> {
  const { channel } = ctx.gateway;
  return eventStream(async (out) => {
    const queue = new Queue();
    const stop = channel.listen(queue);
    try {
      await out.send(": connected\n\n");
      while (!out.signal.aborted && !channel.closed) {
        const record = await queue.take(KEEP_ALIVE_MS);
        if (record === null || !(await ctx.alive())) break;
        await out.send(
          record === undefined ? ": still here\n\n" : `data: ${JSON.stringify(record)}\n\n`,
        );
      }
    } finally {
      stop();
    }
  });
}

export function chatRoutes(router: ApiRouter): void {
  router
    .add("GET", "/api/messages", history)
    .add("POST", "/api/messages", post)
    .add("POST", "/api/approvals", decide)
    .add("GET", "/api/tasks", tasks)
    .add("GET", "/api/stream", stream);
}
