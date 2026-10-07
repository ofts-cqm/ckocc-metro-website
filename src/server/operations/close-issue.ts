import { github, repositoryConfig } from "@/server/github/client";
import { assertEligibleIssue, invalidateIssues } from "@/server/github/issues";
import { checkpoint, type Operation } from "./store";

export async function processCloseIssue(op: Operation, token: string) {
  if (op.checkpoint.closeResult) {
    await invalidateIssues();
    return op.checkpoint.closeResult as Record<string, unknown>;
  }
  const number = Number(op.payload.issueNumber);
  const issue = await assertEligibleIssue(number);
  if (issue.state !== "closed") {
    const client = await github();
    const { owner, repo } = repositoryConfig();
    // Setting a state is idempotent: a retry after a timeout observes the closed issue.
    await client.rest.issues.update({
      owner,
      repo,
      issue_number: number,
      state: "closed",
    });
  }
  const result = { number, state: "closed", url: issue.html_url };
  await checkpoint(op.id, token, { closeResult: result });
  await invalidateIssues();
  return result;
}
