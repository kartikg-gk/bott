import { z } from "zod";
import type { App } from "./app.ts";
import { AppError, bearer, jsonOutput, request } from "./http.ts";
import { text, tool } from "./schema.ts";

const API = "https://api.linear.app/graphql";
const issueInput = {
  title: text,
  description: z.string(),
  state_id: text,
  assignee_id: z.string().nullable(),
  priority: z.number().int().min(0).max(4),
  project_id: z.string().nullable(),
};
const issueOptional = Object.keys(issueInput);

const tools = [
  tool(
    "linear_list_teams",
    "Show the Linear teams you can reach and their workflow states.",
    { cursor: text },
    { optional: "all" },
  ),
  tool(
    "linear_list_issues",
    "Show recent Linear issues, for one team if given.",
    { team_id: text, cursor: text },
    { optional: "all" },
  ),
  tool(
    "linear_search_issues",
    "Search Linear issues for text, for one team if given.",
    { query: text, team_id: text, cursor: text },
    { optional: ["team_id", "cursor"] },
  ),
  tool("linear_get_issue", "Read a Linear issue by its UUID or identifier.", { issue_id: text }),
  tool(
    "linear_create_issue",
    "Open a Linear issue in the team chosen.",
    { team_id: text, ...issueInput },
    { optional: issueOptional.filter((k) => k !== "title"), write: true, review: true },
  ),
  tool(
    "linear_update_issue",
    "Change chosen fields of a Linear issue.",
    { issue_id: text, ...issueInput },
    { optional: issueOptional, write: true, review: true },
  ),
  tool(
    "linear_add_comment",
    "Add a Markdown comment to a Linear issue.",
    { issue_id: text, body: text },
    { write: true, review: true },
  ),
];

const ISSUE = "id identifier title url priority state { id name } team { id key }";
const PAGE = "pageInfo { hasNextPage endCursor }";
const INPUT_NAMES: Record<string, string> = {
  title: "title",
  description: "description",
  state_id: "stateId",
  assignee_id: "assigneeId",
  priority: "priority",
  project_id: "projectId",
};

const QUERIES: Record<string, [string, string]> = {
  linear_list_teams: [
    "teams",
    `query Teams($after: String) { teams(first: 10, after: $after) { nodes { id key name ` +
      `states(first: 15) { nodes { id name type } ${PAGE} } } ${PAGE} } }`,
  ],
  linear_list_issues: [
    "issues",
    `query Issues($after: String, $filter: IssueFilter) { issues(first: 20, after: $after, ` +
      `filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE} } ${PAGE} } }`,
  ],
  linear_search_issues: [
    "searchIssues",
    `query SearchIssues($term: String!, $after: String, $filter: IssueFilter) { ` +
      `searchIssues(term: $term, first: 20, after: $after, filter: $filter) { ` +
      `nodes { ${ISSUE} } ${PAGE} } }`,
  ],
  linear_get_issue: [
    "issue",
    `query Issue($id: String!) { issue(id: $id) { ${ISSUE} description dueDate ` +
      `assignee { id name } project { id name } comments(first: 10) { ` +
      `nodes { id body user { name } createdAt } ${PAGE} } } }`,
  ],
};

const MUTATIONS: Record<string, [string, string, string]> = {
  linear_create_issue: [
    "issueCreate",
    "issue",
    `mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success ` +
      `issue { ${ISSUE} } } }`,
  ],
  linear_update_issue: [
    "issueUpdate",
    "issue",
    `mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, ` +
      `input: $input) { success issue { ${ISSUE} } } }`,
  ],
  linear_add_comment: [
    "commentCreate",
    "comment",
    "mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success " +
      "comment { id url } } }",
  ],
};

// biome-ignore lint/suspicious/noExplicitAny: Linear replies are loose JSON
type Item = Record<string, any>;

export const linear: App = {
  name: "linear",
  tools,
  configured: () => false,
  retryOnRefusal: true,
  async run(ctx, name, a) {
    const headers = bearer(await ctx.token());
    const query = async (field: string, document: string, variables: Item) => {
      const result = await request<Item>(ctx.fetch, "POST", API, {
        headers,
        json: { query: document, variables },
      });
      const data = result?.data?.[field];
      if (result?.errors || !data || typeof data !== "object") {
        throw new AppError(
          "Linear sent back a partial result; look at the target before trying again.",
        );
      }
      return data as Item;
    };
    const read = QUERIES[name];
    if (read) {
      let variables: Item = { after: a.cursor ?? null };
      if (name === "linear_get_issue") variables = { id: a.issue_id };
      if (name === "linear_list_issues" || name === "linear_search_issues") {
        variables.filter = a.team_id ? { team: { id: { eq: a.team_id } } } : null;
      }
      if (name === "linear_search_issues") variables.term = a.query;
      return jsonOutput(await query(read[0], read[1], variables));
    }
    const write = MUTATIONS[name];
    if (!write) throw new AppError("Unknown tool");
    const [field, node, document] = write;
    let payload: Item;
    if (name === "linear_add_comment") {
      payload = { issueId: a.issue_id, body: a.body };
    } else {
      payload = {};
      for (const [key, target] of Object.entries(INPUT_NAMES)) {
        if (key in a) payload[target] = a[key];
      }
      if (Object.keys(payload).length === 0) throw new AppError("Give at least one field of the issue");
    }
    const variables: Item = { input: payload };
    if (name === "linear_create_issue") payload.teamId = a.team_id;
    if (name === "linear_update_issue") variables.id = a.issue_id;
    const result = await query(field, document, variables);
    if (result.success !== true || !result[node] || typeof result[node] !== "object") {
      throw new AppError("Linear did not confirm the change; look at the issue before trying again.");
    }
    return jsonOutput(result[node]);
  },
};
