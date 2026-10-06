import type { IssueSummary, IssueDetail, IssueComment } from "@/lib/contracts";
import { requestSchema, commentSchema } from "@/lib/schemas";
import { query, transaction } from "@/server/db";
import { github, repositoryConfig, expectedBotLogin } from "./client";
import { requestTemplate, commentTemplate } from "./templates";
import { PipelineError } from "@/server/operations/errors";
import type { Operation } from "@/server/operations/store";

type Issue = Awaited<
  ReturnType<Awaited<ReturnType<typeof github>>["rest"]["issues"]["get"]>
>["data"];
const labels = (issue: Issue) =>
  issue.labels.map((l) => (typeof l === "string" ? l : l.name || ""));
export const eligible = (issue: Issue) =>
  !issue.pull_request && labels(issue).includes("metro-request");
function summary(issue: Issue): IssueSummary {
  const tags = labels(issue);
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state === "closed" ? "closed" : "open",
    kind: tags.includes("type:general")
      ? "general"
      : tags.includes("type:line-update")
        ? "line-update"
        : "unknown",
    gameName: null,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    commentsCount: issue.comments,
    labels: tags,
    url: issue.html_url,
    locked: !!issue.locked,
  };
}

function operationMarker(body: string | null | undefined): string | null {
  return (
    body?.match(
      /<!-- metro-operation:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) -->$/,
    )?.[1] ?? null
  );
}
async function matchingOperations(items: { body?: string | null }[]) {
  const ids = [
    ...new Set(
      items
        .map((i) => operationMarker(i.body))
        .filter((id): id is string => !!id),
    ),
  ];
  if (!ids.length) return new Map<string, Operation>();
  const result = await query<Operation>(
    "SELECT * FROM metro_operations WHERE id=ANY($1::uuid[])",
    [ids],
  );
  return new Map(result.rows.map((op) => [op.id, op]));
}
function trustedRequest(issue: Issue, operations: Map<string, Operation>) {
  if (issue.user?.login !== expectedBotLogin()) return null;
  const id = operationMarker(issue.body);
  const op = id ? operations.get(id) : undefined;
  if (!op || op.kind !== "request" || op.result.number !== issue.number)
    return null;
  const parsed = requestSchema.safeParse(op.payload);
  if (
    !parsed.success ||
    requestTemplate(parsed.data, op.id).body !== issue.body
  )
    return null;
  return parsed.data;
}

async function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  const namespaced = `${repositoryConfig().key}:${key}`;
  const hit = await query<{ payload: T }>(
    "SELECT payload FROM metro_github_cache WHERE cache_key=$1 AND fetched_at > now()-interval '60 seconds'",
    [namespaced],
  );
  if (hit.rows[0]) return hit.rows[0].payload;
  // Lock protects the bounded read refresh from a stampede across serverless instances.
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `cache:${namespaced}`,
    ]);
    const again = await client.query<{ payload: T }>(
      "SELECT payload FROM metro_github_cache WHERE cache_key=$1 AND fetched_at > now()-interval '60 seconds'",
      [namespaced],
    );
    if (again.rows[0]) return again.rows[0].payload;
    const payload = await read();
    await client.query(
      "INSERT INTO metro_github_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=$2,fetched_at=now()",
      [namespaced, JSON.stringify(payload)],
    );
    return payload;
  });
}

export async function assertEligibleIssue(
  number: number,
  writable = false,
): Promise<Issue> {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new PipelineError("issue_not_found", 404);
  const client = await github();
  const { owner, repo } = repositoryConfig();
  const issue = (
    await client.rest.issues.get({ owner, repo, issue_number: number })
  ).data;
  if (!eligible(issue)) throw new PipelineError("issue_not_found", 404);
  if (writable && (issue.state !== "open" || issue.locked))
    throw new PipelineError("issue_read_only", 409);
  return issue;
}

export async function listIssues(
  page: number,
  state: "open" | "closed",
  kind?: "general" | "line-update",
) {
  const result = await cached(
    `issues:${state}:${kind || "all"}:${page}`,
    async () => {
      const client = await github();
      const { owner, repo } = repositoryConfig();
      const result = await client.rest.issues.listForRepo({
        owner,
        repo,
        state,
        labels: `metro-request${kind ? `,type:${kind}` : ""}`,
        page,
        per_page: 30,
        sort: "updated",
        direction: "desc",
      });
      return {
        raw: result.data.filter(eligible),
        hasMore: /rel="next"/.test(result.headers.link || ""),
      };
    },
  );
  const operations = await matchingOperations(result.raw);
  return {
    issues: result.raw.map((issue) => ({
      ...summary(issue),
      gameName: trustedRequest(issue, operations)?.gameName ?? null,
    })),
    page,
    hasMore: result.hasMore,
  };
}

export async function issueDetail(number: number): Promise<IssueDetail> {
  // Eligibility is always fresh. A removed public label cannot survive a cached body.
  const issue = await assertEligibleIssue(number);
  const request = trustedRequest(issue, await matchingOperations([issue]));
  return {
    ...summary(issue),
    gameName: request?.gameName ?? null,
    body: issue.body || "",
    request,
  };
}

export async function issueComments(number: number, page: number) {
  await assertEligibleIssue(number);
  const result = await cached(`comments:${number}:${page}`, async () => {
    const client = await github();
    const { owner, repo } = repositoryConfig();
    const response = await client.rest.issues.listComments({
      owner,
      repo,
      issue_number: number,
      page,
      per_page: 30,
    });
    return {
      raw: response.data,
      hasMore: /rel="next"/.test(response.headers.link || ""),
    };
  });
  const operations = await matchingOperations(result.raw);
  const comments: IssueComment[] = result.raw.map((c) => {
    const marker = operationMarker(c.body);
    const op = marker ? operations.get(marker) : undefined;
    const parsed = commentSchema.safeParse(
      op
        ? {
            gameName: op.payload.gameName,
            comment: op.payload.comment,
            locale: op.payload.locale,
          }
        : {},
    );
    const trusted =
      c.user?.login === expectedBotLogin() &&
      op?.kind === "comment" &&
      op.result.commentId === c.id &&
      op.payload.issueNumber === number &&
      parsed.success &&
      commentTemplate(parsed.data, op.id) === c.body;
    return {
      id: c.id,
      body: c.body || "",
      gameName: trusted && parsed.success ? parsed.data.gameName : null,
      author: c.user?.login || "GitHub",
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      unverified: !!trusted,
    };
  });
  return { comments, page, hasMore: result.hasMore };
}

export async function invalidateIssues() {
  await query("DELETE FROM metro_github_cache WHERE cache_key LIKE $1", [
    `${repositoryConfig().key}:%`,
  ]);
}
