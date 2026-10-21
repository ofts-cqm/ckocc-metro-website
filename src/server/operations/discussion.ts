import type { RequestPayload, CommentPayload } from "@/lib/contracts";
import {
  github,
  repositoryConfig,
  expectedBotLogin,
} from "@/server/github/client";
import {
  assertEligibleIssue,
  assertReplyTarget,
  invalidateIssues,
} from "@/server/github/issues";
import {
  requestTemplate,
  commentTemplate,
  marker,
} from "@/server/github/templates";
import { checkpoint, type Operation } from "./store";
import { PipelineError } from "./errors";

async function recoverDiscussion(
  op: Operation,
  expectedBody: string | string[],
  issueNumber?: number,
) {
  const client = await github();
  const { owner, repo } = repositoryConfig();
  const bot = expectedBotLogin();
  const expectedBodies = Array.isArray(expectedBody)
    ? expectedBody
    : [expectedBody];
  const matches: { number?: number; commentId?: number; url: string }[] = [];
  const deadline = Date.now() + 60_000;
  let complete = false;
  for (let page = 1; page <= 25 && Date.now() < deadline; page++) {
    if (issueNumber) {
      const response = await client.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        page,
        per_page: 100,
        since: new Date(
          new Date(op.created_at).getTime() - 60_000,
        ).toISOString(),
      });
      for (const c of response.data)
        if (
          c.user?.login === bot &&
          expectedBodies.includes(c.body || "") &&
          c.body?.includes(marker(op.id))
        )
          matches.push({
            number: issueNumber,
            commentId: c.id,
            url: c.html_url,
          });
      if (!/rel="next"/.test(response.headers.link || "")) {
        complete = true;
        break;
      }
    } else {
      // List API is authoritative; do not rely on eventually indexed search.
      const response = await client.rest.issues.listForRepo({
        owner,
        repo,
        state: "all",
        sort: "created",
        direction: "desc",
        page,
        per_page: 100,
        since: new Date(
          new Date(op.created_at).getTime() - 60_000,
        ).toISOString(),
      });
      for (const issue of response.data)
        if (
          !issue.pull_request &&
          issue.user?.login === bot &&
          expectedBodies.includes(issue.body || "") &&
          issue.body?.includes(marker(op.id))
        )
          matches.push({ number: issue.number, url: issue.html_url });
      if (!/rel="next"/.test(response.headers.link || "")) {
        complete = true;
        break;
      }
    }
  }
  if (!complete || matches.length !== 1)
    throw new PipelineError("outcome_unknown", 409);
  return matches[0];
}

export async function processDiscussion(op: Operation, token: string) {
  const client = await github();
  const { owner, repo } = repositoryConfig();
  // Fail before any write if recovery identity is not configured.
  expectedBotLogin();
  if (op.kind === "request") {
    const template = requestTemplate(
      op.payload as unknown as RequestPayload,
      op.id,
    );
    if (op.checkpoint.discussionResult)
      return op.checkpoint.discussionResult as Record<string, unknown>;
    if (op.checkpoint.writeIntent) return recoverDiscussion(op, template.body);
    await checkpoint(op.id, token, { writeIntent: true });
    const result = await client.rest.issues.create({
      owner,
      repo,
      ...template,
    });
    const value = { number: result.data.number, url: result.data.html_url };
    await checkpoint(op.id, token, { discussionResult: value });
    await invalidateIssues();
    return value;
  }
  const issueNumber = Number(op.payload.issueNumber);
  const issueUrl = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
  const body = commentTemplate(
    op.payload as unknown as CommentPayload,
    op.id,
    !!op.actor_id,
    issueUrl,
  );
  if (op.checkpoint.discussionResult)
    return op.checkpoint.discussionResult as Record<string, unknown>;
  if (op.checkpoint.writeIntent)
    return recoverDiscussion(
      op,
      op.actor_id
        ? [
            body,
            commentTemplate(
              op.payload as unknown as CommentPayload,
              op.id,
              false,
              issueUrl,
            ),
          ]
        : body,
      issueNumber,
    );
  await assertEligibleIssue(issueNumber, true);
  if (op.payload.replyToCommentId)
    await assertReplyTarget(issueNumber, Number(op.payload.replyToCommentId));
  await checkpoint(op.id, token, { writeIntent: true });
  const result = await client.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  const value = {
    number: issueNumber,
    commentId: result.data.id,
    url: result.data.html_url,
  };
  await checkpoint(op.id, token, { discussionResult: value });
  await invalidateIssues();
  return value;
}
