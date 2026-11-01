import { z } from "zod";
import { type App, type AppContext, envSet } from "./app.ts";
import { AppError, jsonOutput, limited, request, send } from "./http.ts";
import { count, offset, text, tool } from "./schema.ts";

export const GITHUB_TOKEN = "BOTT_GITHUB_TOKEN";
const API = "https://api.github.com";

const tools = [
  tool(
    "github_list_repositories",
    "Show repositories the connected GitHub account can reach, from page 1.",
    { page: count },
    { optional: "all" },
  ),
  tool("github_get_repository", "Read repository metadata.", { repo: text }),
  tool(
    "github_list_issue_comments",
    "Read a page of comments on an issue or pull request.",
    { repo: text, number: count, page: count },
    { optional: ["page"] },
  ),
  tool(
    "github_list_pull_requests",
    "Show a page of pull requests; open ones unless told otherwise.",
    { repo: text, page: count, state: z.enum(["open", "closed", "all"]) },
    { optional: ["page", "state"] },
  ),
  tool("github_get_pull_request", "Read a pull request with its branches and whether it can merge.", {
    repo: text,
    number: count,
  }),
  tool(
    "github_list_pull_request_files",
    "Show which paths changed with short patches; give a filename to page through its patch.",
    { repo: text, number: count, page: count, filename: text, offset },
    { optional: ["page", "filename", "offset"] },
  ),
  tool(
    "github_create_pull_request",
    "Open a pull request from a branch that exists, when asked to.",
    {
      repo: text,
      title: text,
      head: text,
      base: text,
      body: z.string(),
      draft: z.boolean(),
    },
    { optional: ["body", "draft"], write: true, review: true },
  ),
  tool("github_list_issues", "Show the open issues and pull requests of a repository.", {
    repo: text,
  }),
  tool("github_get_issue", "Read a single issue or pull request.", { repo: text, number: count }),
  tool(
    "github_read_file",
    "Read a text file stored in a repository.",
    { repo: text, path: text, ref: text },
    { optional: ["ref"] },
  ),
  tool(
    "github_create_issue",
    "Open an issue, but only when the task given asks for one.",
    { repo: text, title: text, body: z.string() },
    { write: true },
  ),
  tool(
    "github_comment",
    "Comment on an issue or pull request, but only when the task given asks for it.",
    { repo: text, number: count, body: text },
    { write: true },
  ),
];

/** Which fields each read keeps, and the path under the repository. */
const READS: Record<string, { route: string; fields: string[]; paged: boolean }> = {
  github_list_repositories: {
    route: "/user/repos",
    fields: ["full_name", "description", "private", "html_url"],
    paged: true,
  },
  github_get_repository: {
    route: "",
    fields: ["full_name", "description", "default_branch", "private", "html_url"],
    paged: false,
  },
  github_list_issue_comments: {
    route: "/issues/{number}/comments",
    fields: ["id", "user", "body", "html_url"],
    paged: true,
  },
  github_list_pull_requests: {
    route: "/pulls",
    fields: ["number", "title", "state", "draft", "html_url"],
    paged: true,
  },
  github_get_pull_request: {
    route: "/pulls/{number}",
    fields: [
      "number",
      "title",
      "body",
      "state",
      "draft",
      "merged",
      "head",
      "base",
      "html_url",
      "changed_files",
      "additions",
      "deletions",
    ],
    paged: false,
  },
  github_list_pull_request_files: {
    route: "/pulls/{number}/files",
    fields: ["filename", "previous_filename", "status", "additions", "deletions", "patch"],
    paged: true,
  },
};

type Item = Record<string, unknown>;

export function repository(name: unknown): string {
  if (typeof name !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(name) || name.includes("..")) {
    throw new AppError("Name the repository as owner/name");
  }
  return name;
}

/** Keeps the listed fields, shortens long bodies and patches, and flattens users and branches. */
export function pick(item: Item, fields: string[], includePatch = true): Item {
  const out: Item = {};
  for (const field of fields) if (field in item) out[field] = item[field];
  if ("user" in out) out.user = (out.user as Item | null)?.login ?? null;
  for (const branch of ["head", "base"]) {
    if (branch in out) {
      const ref = (out[branch] ?? {}) as Item;
      out[branch] = { ref: ref.ref ?? null, label: ref.label ?? null, sha: ref.sha ?? null };
    }
  }
  if (typeof out.body === "string" && out.body.length > 1200) {
    out.body = out.body.slice(0, 1200);
    out.bodyTruncated = true;
  }
  if (!includePatch) delete out.patch;
  if (typeof out.patch === "string" && out.patch.length > 900) {
    out.patch = out.patch.slice(0, 900);
    out.patchTruncated = true;
  }
  return out;
}

function hasNext(link: string | null): boolean {
  return (link ?? "").split(",").some((part) => /;\s*rel="?next"?/.test(part));
}

async function token(ctx: AppContext): Promise<string> {
  if (ctx.accounts) return ctx.token();
  const value = ctx.env[GITHUB_TOKEN]?.trim();
  if (!value) throw new AppError("github is not set up on the server.");
  return value;
}

async function run(ctx: AppContext, name: string, a: Record<string, unknown>): Promise<string> {
  const headers = {
    authorization: `Bearer ${await token(ctx)}`,
    accept: "application/vnd.github+json",
  };
  const base = name === "github_list_repositories" ? API : `${API}/repos/${repository(a.repo)}`;
  const read = READS[name];
  if (read) {
    const params: Record<string, string | number> = {};
    const page = typeof a.page === "number" ? a.page : 1;
    if (read.paged) Object.assign(params, { page, per_page: 10 });
    if (name === "github_list_pull_requests") params.state = String(a.state ?? "open");
    const route = read.route.replace("{number}", String(a.number));
    const reply = await send(ctx.fetch, "GET", base + route, { headers, params });
    const data = (await reply.json()) as Item | Item[];
    if (!read.paged) return jsonOutput(pick(data as Item, read.fields));
    const items = data as Item[];
    if (name === "github_list_pull_request_files" && a.filename) {
      const selected = items.find((item) => item.filename === a.filename);
      if (!selected) throw new AppError("That file is not on this page of the pull request");
      const result = pick(selected, read.fields, false);
      const patch = typeof selected.patch === "string" ? selected.patch : null;
      const start = typeof a.offset === "number" ? a.offset : 0;
      const end = start + 2500;
      result.patch = patch === null ? null : patch.slice(start, end);
      result.nextOffset = patch !== null && end < patch.length ? end : null;
      return jsonOutput(result);
    }
    return jsonOutput({
      items: items.map((item) => pick(item, read.fields)),
      nextPage: hasNext(reply.headers.get("link")) ? page + 1 : null,
    });
  }
  switch (name) {
    case "github_create_pull_request": {
      const body: Item = {};
      for (const field of ["title", "head", "base", "body", "draft"]) {
        if (field in a) body[field] = a[field];
      }
      const created = await request<Item>(ctx.fetch, "POST", `${base}/pulls`, {
        headers,
        json: body,
      });
      return jsonOutput(pick(created, ["number", "html_url", "draft"]));
    }
    case "github_list_issues": {
      const issues = await request<Item[]>(ctx.fetch, "GET", `${base}/issues`, { headers });
      return limited(issues.map((i) => `#${i.number} ${i.title}`).join("\n") || "None.");
    }
    case "github_get_issue": {
      const issue = await request<Item>(ctx.fetch, "GET", `${base}/issues/${a.number}`, {
        headers,
      });
      return limited(`${issue.title} (${issue.state})\n${issue.body ?? ""}`);
    }
    case "github_read_file": {
      // A dot segment would be resolved by the URL and could leave the repository's contents.
      const parts = String(a.path).split("/");
      if (parts.some((part) => part === "." || part === "..")) {
        throw new AppError("Use a file path inside the repository");
      }
      const path = parts.map(encodeURIComponent).join("/");
      const reply = await send(ctx.fetch, "GET", `${base}/contents/${path}`, {
        headers: { ...headers, accept: "application/vnd.github.raw+json" },
        params: a.ref ? { ref: String(a.ref) } : undefined,
      });
      return limited(await reply.text());
    }
    case "github_create_issue": {
      const created = await request<Item>(ctx.fetch, "POST", `${base}/issues`, {
        headers,
        json: { title: a.title, body: a.body },
      });
      return `Created issue #${created.number}.`;
    }
    case "github_comment":
      await send(ctx.fetch, "POST", `${base}/issues/${a.number}/comments`, {
        headers,
        json: { body: a.body },
      });
      return "Comment posted.";
    default:
      throw new AppError("Unknown tool");
  }
}

export const github: App = {
  name: "github",
  tools,
  configured: (env) => envSet(env, GITHUB_TOKEN),
  run,
};
