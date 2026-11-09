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
    "Teams the person belongs to in Linear, each with its workflow states.",
    { cursor: text },
    { optional: "all" },
  ),
  tool(
    "linear_list_issues",
    "The most recently changed issues, across teams or for one team.",
    { team_id: text, cursor: text },
    { optional: "all" },
  ),
  tool(
    "linear_search_issues",
    "Finds issues whose text matches; a team can narrow it.",
    { query: text, team_id: text, cursor: text },
    { optional: ["team_id", "cursor"] },
  ),
  tool("linear_get_issue", "One issue, by its UUID or a key like ENG-12.", { issue_id: text }),
  tool(
    "linear_create_issue",
    "Files a new issue in one team.",
    { team_id: text, ...issueInput },
    { optional: issueOptional.filter((k) => k !== "title"), write: true, review: true },
  ),
  tool(
    "linear_update_issue",
    "Changes only the given fields of an issue.",
    { issue_id: text, ...issueInput },
    { optional: issueOptional, write: true, review: true },
  ),
  tool(
    "linear_add_comment",
    "Adds a comment, written in Markdown, to an issue.",
    { issue_id: text, body: text },
    { write: true, review: true },
  ),
];

const ISSUE = "id identifier url title priority team { id key } state { id name }";
const PAGE = "pageInfo { endCursor hasNextPage }";
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
    `query ListTeams($after: String) { teams(first: 10, after: $after) { nodes { id key name ` +
      `states(first: 15) { nodes { id name type } ${PAGE} } } ${PAGE} } }`,
  ],
  linear_list_issues: [
    "issues",
    `query RecentIssues($filter: IssueFilter, $after: String) { issues(first: 20, after: $after, ` +
      `filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE} } ${PAGE} } }`,
  ],
  linear_search_issues: [
    "searchIssues",
    `query FindIssues($term: String!, $filter: IssueFilter, $after: String) { ` +
      `searchIssues(term: $term, filter: $filter, first: 20, after: $after) { ` +
      `nodes { ${ISSUE} } ${PAGE} } }`,
  ],
  linear_get_issue: [
    "issue",
    `query OneIssue($id: String!) { issue(id: $id) { ${ISSUE} dueDate description ` +
      `project { id name } assignee { id name } comments(first: 10) { ` +
      `nodes { id createdAt user { name } body } ${PAGE} } } }`,
  ],
};

const MUTATIONS: Record<string, [string, string, string]> = {
  linear_create_issue: [
    "issueCreate",
    "issue",
    `mutation NewIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success ` +
      `issue { ${ISSUE} } } }`,
  ],
  linear_update_issue: [
    "issueUpdate",
    "issue",
    `mutation EditIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, ` +
      `input: $input) { success issue { ${ISSUE} } } }`,
  ],
  linear_add_comment: [
    "commentCreate",
    "comment",
    "mutation AddComment($input: CommentCreateInput!) { commentCreate(input: $input) { " +
      "comment { url id } success } }",
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
          "Linear's answer was missing data. Look at the issue before trying again.",
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
      if (Object.keys(payload).length === 0)
        throw new AppError("Name at least one issue field to set");
    }
    const variables: Item = { input: payload };
    if (name === "linear_create_issue") payload.teamId = a.team_id;
    if (name === "linear_update_issue") variables.id = a.issue_id;
    const result = await query(field, document, variables);
    if (result.success !== true || !result[node] || typeof result[node] !== "object") {
      throw new AppError(
        "Linear did not say the change was saved. Look at the issue before trying again.",
      );
    }
    return jsonOutput(result[node]);
  },
};
