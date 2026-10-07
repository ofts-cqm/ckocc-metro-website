import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import type { ActiveUser } from "../src/server/auth/authorize";
import type { Operation } from "../src/server/operations/store";

// Exercise the real routes, authorization, eligibility checks and worker with
// isolated provider/storage boundaries. No deployment credentials are loaded.
const user: ActiveUser = {
  id: "collaborator-id",
  email: "player@example.invalid",
  name: "AccountPlayer",
  role: "collaborator",
};
let signedIn = true;
let active = true;
let validSession = true;
let issue = makeIssue();
let operation: Operation;
let accepted: Parameters<
  typeof import("../src/server/operations/store").acceptOperation
>[0][];
let writes: Record<string, unknown>[];
let invalidations: number;
let authorizations: number;
let finished: string[];
let timeoutAfterWrite: boolean;

function makeIssue() {
  return {
    number: 42,
    state: "open",
    locked: false,
    labels: [{ name: "metro-request" }],
    html_url: "https://example.invalid/issues/42",
    pull_request: undefined as object | undefined,
  };
}

mock.module("../src/server/auth/config.ts", {
  namedExports: {
    getAuth: () => ({
      api: {
        getSession: async () =>
          signedIn
            ? { user, session: { id: "session", createdAt: new Date() } }
            : null,
      },
    }),
    siteOrigin: () => "http://localhost:3000",
  },
});
mock.module("../src/server/db/index.ts", {
  namedExports: {
    query: async (sql: string) => {
      if (sql.includes('SELECT s.id FROM "session"'))
        return { rows: [], rowCount: validSession ? 1 : 0 };
      if (sql.includes("SELECT u.id, u.email, u.name"))
        return { rows: [{ ...user, active }], rowCount: 1 };
      if (sql.startsWith("DELETE FROM metro_github_cache")) {
        invalidations++;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("public_writes_paused"))
        return { rows: [{ public_writes_paused: false }] };
      throw new Error(`Unexpected database access: ${sql}`);
    },
    transaction: async (run: (client: unknown) => Promise<unknown>) =>
      run({ query: async () => ({ rows: [{ count: 1 }] }) }),
  },
});
mock.module("../src/server/github/client.ts", {
  namedExports: {
    repositoryConfig: () => ({
      owner: "test",
      repo: "map",
      key: "test/map",
      branch: "main",
    }),
    github: async () => ({
      rest: {
        issues: {
          get: async () => ({ data: issue }),
          update: async (input: Record<string, unknown>) => {
            writes.push(input);
            issue.state = "closed";
            if (timeoutAfterWrite)
              throw new Error("Provider response timed out");
            return { data: issue };
          },
        },
      },
    }),
  },
});
mock.module("../src/server/operations/store.ts", {
  namedExports: {
    acceptOperation: async (input: (typeof accepted)[number]) => {
      await input.authorize();
      authorizations++;
      accepted.push(input);
      operation = {
        id: "00000000-0000-4000-8000-000000000042",
        kind: input.kind,
        scope: input.scope,
        idempotency_key: input.key,
        request_digest: "test-digest",
        actor_id: input.actorId ?? null,
        receipt_digest: null,
        payload: input.payload,
        checkpoint: { repository: "test/map", baseBranch: "main" },
        result: {},
        status: "accepted",
        attempts: 1,
        error_code: null,
        created_at: new Date(),
        updated_at: new Date(),
        next_attempt_at: new Date(),
      };
      return operation;
    },
    operationView: (op: Operation) => ({ id: op.id, status: op.status }),
    leaseOperation: async () => ({ op: operation, token: "lease" }),
    getOperation: async () => operation,
    checkpoint: async (_id: string, _token: string, data: object) => {
      Object.assign(operation.checkpoint, data);
    },
    finishOperation: async (_id: string, _token: string, status: string) => {
      finished.push(status);
    },
  },
});
mock.module("../src/server/operations/outbox.ts", {
  namedExports: { launchOperation: async () => {} },
});

// Dynamic imports ensure the mocks are installed before loading route dependencies.
let handlers: typeof import("../src/server/operations/handlers");
let executeOperation: typeof import("../src/server/operations/worker").executeOperation;
let processCloseIssue: typeof import("../src/server/operations/close-issue").processCloseIssue;
before(async () => {
  handlers = await import("../src/server/operations/handlers");
  ({ executeOperation } = await import("../src/server/operations/worker"));
  ({ processCloseIssue } =
    await import("../src/server/operations/close-issue"));
});

beforeEach((t) => {
  if (!("mock" in t)) throw new Error("Expected a test context");
  signedIn = true;
  active = true;
  validSession = true;
  user.role = "collaborator";
  issue = makeIssue();
  accepted = [];
  writes = [];
  finished = [];
  invalidations = 0;
  authorizations = 0;
  timeoutAfterWrite = false;
  process.env.ABUSE_HASH_SECRET = "a".repeat(32);
  process.env.TURNSTILE_SECRET_KEY = "test-secret";
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    assert.equal(
      url,
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    return Response.json({
      success: true,
      action: "request",
      hostname: "localhost",
    });
  });
});

function request(body: object, origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "Idempotency-Key": "00000000-0000-4000-8000-000000000001",
    },
    body: JSON.stringify(body),
  });
}
const context = { params: Promise.resolve({ number: "42" }) };
const general = {
  kind: "general",
  locale: "en-US",
  comment: "Please add a station.",
  challengeToken: "test-challenge",
  receiptToken: "a".repeat(43),
};

for (const role of ["collaborator", "admin"] as const) {
  test(`${role} requests use the account name, including omitted or forged names`, async () => {
    user.role = role;
    for (const gameName of [undefined, "ForgedPlayer", null, "bad\nname"]) {
      for (const payload of [
        general,
        {
          ...general,
          kind: "line-update",
          comment: undefined,
          lineType: "double-track-rail",
          operation: "add",
          stations: [{ chineseName: "站", x: 1, z: 2 }],
        },
      ]) {
        const response = await handlers.postRequest(
          request({ ...payload, gameName }),
          context,
        );
        assert.equal(response.status, 202, await response.text());
        assert.equal(accepted.at(-1)?.payload.gameName, "AccountPlayer");
        assert.equal(accepted.at(-1)?.actorId, user.id);
      }
    }
    assert.equal(authorizations, 8);
  });
  test(`${role} can close a request through the worker`, async () => {
    user.role = role;
    assert.equal(
      (await handlers.postCloseIssue(request({}), context)).status,
      202,
    );
    assert.equal(operation.actor_id, user.id);
    await executeOperation(operation.id);
    assert.deepEqual(writes, [
      { owner: "test", repo: "map", issue_number: 42, state: "closed" },
    ]);
    assert.deepEqual(finished, ["succeeded"]);
    assert.equal(invalidations, 1);
    // A completed checkpoint never closes an issue again if someone reopens it.
    issue.state = "open";
    await processCloseIssue(operation, "lease");
    assert.equal(writes.length, 1);
  });
}

test("anonymous requests still require a supplied name and cannot close issues", async () => {
  signedIn = false;
  assert.equal(
    (await handlers.postRequest(request(general), context)).status,
    422,
  );
  assert.equal(
    (
      await handlers.postRequest(
        request({ ...general, gameName: "Visitor" }),
        context,
      )
    ).status,
    202,
  );
  assert.equal(accepted[0].payload.gameName, "Visitor");
  assert.equal(accepted[0].actorId, undefined);
  assert.equal(
    (await handlers.postCloseIssue(request({}), context)).status,
    401,
  );
  assert.equal(accepted.length, 1);
});

test("disabled and revoked sessions cannot submit or close as collaborators", async () => {
  for (const state of ["disabled", "revoked"]) {
    active = state !== "disabled";
    validSession = state !== "revoked";
    assert.equal(
      (
        await handlers.postRequest(
          request({ ...general, gameName: "Forged" }),
          context,
        )
      ).status,
      401,
    );
    assert.equal(
      (await handlers.postCloseIssue(request({}), context)).status,
      401,
    );
  }
  assert.equal(accepted.length, 0);
});

test("closing rejects foreign origins, non-request issues, PRs and extra authority", async () => {
  assert.equal(
    (
      await handlers.postCloseIssue(
        request({}, "https://evil.invalid"),
        context,
      )
    ).status,
    403,
  );
  assert.equal(
    (await handlers.postCloseIssue(request({ state: "open" }), context)).status,
    422,
  );
  issue.labels = [];
  assert.equal(
    (await handlers.postCloseIssue(request({}), context)).status,
    404,
  );
  issue = makeIssue();
  issue.pull_request = {};
  assert.equal(
    (await handlers.postCloseIssue(request({}), context)).status,
    404,
  );
  assert.equal(accepted.length, 0);
  assert.equal(writes.length, 0);
});

test("the worker rechecks account and issue eligibility before closing", async () => {
  for (const change of ["disabled", "unlabeled", "missing-actor"]) {
    active = true;
    issue = makeIssue();
    assert.equal(
      (await handlers.postCloseIssue(request({}), context)).status,
      202,
    );
    if (change === "disabled") active = false;
    if (change === "unlabeled") issue.labels = [];
    if (change === "missing-actor") operation.actor_id = null;
    await executeOperation(operation.id);
    assert.equal(finished.at(-1), "failed");
  }
  assert.equal(writes.length, 0);
});

test("already closed requests succeed without another GitHub write", async () => {
  issue.state = "closed";
  assert.equal(
    (await handlers.postCloseIssue(request({}), context)).status,
    202,
  );
  await executeOperation(operation.id);
  assert.equal(writes.length, 0);
  assert.deepEqual(finished, ["succeeded"]);
  assert.equal(invalidations, 1);
});

test("a timeout after GitHub closes a request recovers without repeating the write", async () => {
  assert.equal(
    (await handlers.postCloseIssue(request({}), context)).status,
    202,
  );
  timeoutAfterWrite = true;
  assert.equal((await executeOperation(operation.id)).retry, true);
  assert.equal(issue.state, "closed");
  assert.equal((await executeOperation(operation.id)).retry, false);
  assert.deepEqual(finished, ["failed", "succeeded"]);
  assert.equal(writes.length, 1);
  assert.equal(invalidations, 1);
});
