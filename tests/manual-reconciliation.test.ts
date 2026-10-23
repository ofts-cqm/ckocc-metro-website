import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectOperation,
  type Snapshot,
  type PullEvidence,
} from "../scripts/lib/reconcile-operations";

const id = "00000000-0000-4000-8000-000000000001";
function operation(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id,
    kind: "update",
    status: "failed",
    checkpoint: {
      repository: "local/test",
      baseBranch: "main",
      deletedAt: new Date().toISOString(),
      autoRetry: false,
    },
    payload: {},
    result: {},
    lease_until: null,
    version: "1",
    error_code: "unsupported_map_format",
    ...overrides,
  } as Snapshot;
}
const pr: PullEvidence = {
  number: 42,
  repository: "local/test",
  creator: "metro[bot]",
  state: "closed",
  merged: false,
  mergedAt: null,
  mergeCommitSha: null,
};
const context = {
  repository: "local/test",
  branch: "main",
  bot: "metro[bot]",
  readPull: async () => pr,
};
const source = operation({
  status: "closed_unmerged",
  result: { prNumber: 42 },
});
const inspect = (op: Snapshot) =>
  inspectOperation(op, context, async () => source);

test("deleted pre-write uploads retire without provider access; uncertainty and leases remain", async () => {
  const decision = await inspectOperation(
    operation(),
    {
      ...context,
      readPull: async () => {
        throw new Error("unexpected read");
      },
    },
    async () => undefined,
  );
  assert.equal(decision.status, "superseded");
  for (const patch of [
    { status: "outcome_unknown" },
    { lease_until: new Date(Date.now() + 60000) },
    { result: { publicationPending: true } },
    { result: { prNumber: 42 } },
    ...["prIntent", "prResult", "branchIntent", "commitSha"].map((key) => ({
      checkpoint: { ...operation().checkpoint, [key]: "recorded" },
    })),
    { checkpoint: { ...operation().checkpoint, autoRetry: true } },
    { checkpoint: { ...operation().checkpoint, repository: "wrong/repo" } },
  ] as Partial<Snapshot>[])
    assert.equal((await inspect(operation(patch))).status, undefined);
});

test("obsolete actions require matching closed PR evidence and no write intent", async () => {
  for (const kind of [
    "merge",
    "close-update",
    "edit-update",
    "refresh-update",
  ] as const) {
    const op = operation({ kind, payload: { updateId: id } });
    assert.equal((await inspect(op)).status, "superseded");
    for (const evidence of [
      { ...pr, state: "open" },
      { ...pr, creator: "other" },
      { ...pr, repository: "wrong/repo" },
      { ...pr, number: 43 },
    ])
      assert.equal(
        (
          await inspectOperation(
            op,
            { ...context, readPull: async () => evidence },
            async () => source,
          )
        ).status,
        undefined,
      );
    assert.equal(
      (
        await inspectOperation(
          op,
          {
            ...context,
            readPull: async () => {
              throw new Error("offline");
            },
          },
          async () => source,
        )
      ).reason,
      "provider_unavailable",
    );
    assert.equal(
      (
        await inspect(
          operation({
            ...op,
            checkpoint: { ...op.checkpoint, mergeIntent: {} },
          }),
        )
      ).status,
      undefined,
    );
  }
});

test("PR synchronization preserves publication as a separate unresolved step", async () => {
  const op = operation({ status: "awaiting_review", result: { prNumber: 42 } });
  assert.equal((await inspect(op)).status, "closed_unmerged");
  const decision = await inspectOperation(
    op,
    {
      ...context,
      readPull: async () => ({
        ...pr,
        merged: true,
        mergeCommitSha: "a".repeat(40),
      }),
    },
    async () => undefined,
  );
  assert.equal(decision.status, "merged");
  assert.equal(decision.result?.publicationPending, true);
  assert.equal(
    (
      await inspect(
        operation({ status: "published", result: { prNumber: 42 } }),
      )
    ).status,
    undefined,
  );
  for (const kind of ["request", "comment", "sync", "close-issue"] as const)
    assert.equal(
      (await inspect(operation({ kind }))).reason,
      "action_specific_recovery_required",
    );
});
