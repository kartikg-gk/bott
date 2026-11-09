import { z } from "zod";
import type { App } from "./app.ts";
import { type GoogleApi, googleApi, segment } from "./google.ts";
import { AppError, jsonOutput } from "./http.ts";
import { text, tool } from "./schema.ts";

const API = "https://tasks.googleapis.com/tasks/v1";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const taskFields = {
  title: text,
  notes: z.string(),
  due: z.string().nullable(),
  status: z.enum(["needsAction", "completed"]),
};

const tools = [
  tool(
    "tasks_list_lists",
    "The person's Google Tasks lists, with their IDs.",
    { page_token: text },
    { optional: "all" },
  ),
  tool(
    "tasks_list",
    "The tasks on one list. Finished tasks are shown too unless show_completed is false.",
    { list_id: text, page_token: text, show_completed: z.boolean() },
    { optional: ["page_token", "show_completed"] },
  ),
  tool(
    "tasks_create",
    "Adds a task to a list, with optional notes and a due day written YYYY-MM-DD.",
    { list_id: text, ...taskFields },
    { optional: ["notes", "due", "status"], write: true, review: true },
  ),
  tool(
    "tasks_update",
    "Changes only the fields given. A due of null clears the day; status completed ticks the " +
      "task off and needsAction opens it again.",
    { list_id: text, task_id: text, ...taskFields },
    { optional: ["title", "notes", "due", "status"], write: true, review: true },
  ),
];

// biome-ignore lint/suspicious/noExplicitAny: Google replies are loose JSON
type Item = Record<string, any>;

/** A due day as Google Tasks stores it: midnight UTC of that day. */
function dueDay(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && DAY.test(value)) {
    const day = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(day.getTime()) && day.toISOString().startsWith(value)) {
      return day.toISOString();
    }
  }
  throw new AppError("Write the due day as YYYY-MM-DD");
}

function taskBody(a: Item): Item {
  const body: Item = {};
  for (const key of ["title", "notes", "status"]) if (key in a) body[key] = a[key];
  // A reopened task loses the time it was finished.
  if (a.status === "needsAction") body.completed = null;
  if ("due" in a) body.due = dueDay(a.due);
  if (Object.keys(body).length === 0) throw new AppError("Name at least one field to change");
  return body;
}

async function page(api: GoogleApi, url: string, a: Item, fields: string, query = {}) {
  const data = await api.get<Item>(url, {
    maxResults: 20,
    fields: `nextPageToken,items(${fields})`,
    ...query,
    pageToken: a.page_token,
  });
  return { items: data?.items ?? [], nextPageToken: data?.nextPageToken ?? null };
}

async function run(api: GoogleApi, name: string, a: Item): Promise<Item> {
  if (name === "tasks_list_lists") {
    return page(api, `${API}/users/@me/lists`, a, "id,title,updated");
  }
  const base = `${API}/lists/${segment(a.list_id)}/tasks`;
  if (name === "tasks_list") {
    const shown = a.show_completed === false ? "false" : "true";
    const fields = "id,title,notes,status,due,completed,parent,webViewLink";
    return page(api, base, a, fields, { showCompleted: shown, showHidden: shown });
  }
  if (name === "tasks_create") return api.call("POST", base, { json: taskBody(a) });
  if (name === "tasks_update") {
    const { list_id: _list, task_id, ...fields } = a;
    return api.call("PATCH", `${base}/${segment(task_id)}`, { json: taskBody(fields) });
  }
  throw new AppError("Unknown Tasks tool");
}

export const tasks: App = {
  name: "tasks",
  tools,
  configured: () => false,
  async run(ctx, name, args) {
    return jsonOutput(await run(googleApi(ctx.fetch, await ctx.token()), name, args));
  },
};
