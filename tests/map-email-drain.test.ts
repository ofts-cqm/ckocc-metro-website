import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
let recipients: string[];
let cursor: string | null;
let complete: boolean;
let clock: number;
let failLaunches: boolean;
let queries: number;
let launched: Set<string>;
let outbox: Map<string, { state: string; due: number }>;
async function query(sql: string, values: any[] = []) {
  queries++;
  if (sql.includes("SELECT id,recipient_cursor"))
    return {
      rows: complete ? [] : [{ id: "event", recipient_cursor: cursor }],
    };
  if (sql.includes("SELECT u.id FROM"))
    return {
      rows: recipients
        .filter((id) => !cursor || id > cursor)
        .slice(0, 250)
        .map((id) => ({ id })),
    };
  if (sql.includes("INSERT INTO metro_email_jobs")) {
    const rows = values[1]
      .filter((id: string) => !outbox.has(id))
      .map((id: string) => ({ id }));
    for (const row of rows) outbox.set(row.id, { state: "pending", due: 0 });
    return { rows };
  }
  if (sql.includes("UPDATE metro_map_publication_events")) {
    cursor = values[1] ?? cursor;
    complete = values[2];
  }
  if (sql.includes("SELECT b.job_id"))
    return {
      rows: [...outbox]
        .filter(([, job]) => job.state === "pending" && job.due <= clock)
        .slice(0, 25)
        .map(([job_id]) => ({ job_id })),
    };
  if (sql.includes("SET state='launching'")) {
    const job = outbox.get(values[0])!;
    if (job.state !== "pending") return { rows: [], rowCount: 0 };
    job.state = "launching";
    return { rows: [{ job_id: values[0] }], rowCount: 1 };
  }
  if (sql.includes("SET state='started'"))
    outbox.get(values[0])!.state = "started";
  if (sql.includes("SET state='pending',next_attempt_at")) {
    outbox.set(values[0], { state: "pending", due: clock + 60 });
  }
  if (sql.includes("AS remaining"))
    return {
      rows: [
        {
          remaining:
            !complete ||
            [...outbox.values()].some((job) => job.state === "pending"),
        },
      ],
    };
  return { rows: [], rowCount: 1 };
}
mock.module("../src/server/db/index.ts", {
  namedExports: { query, transaction: async (fn: any) => fn({ query }) },
});
mock.module("workflow/api", {
  namedExports: {
    start: async (_workflow: unknown, [id]: string[]) => {
      if (failLaunches) throw new Error("unavailable");
      assert.ok(!launched.has(id), "each recipient launches only once");
      launched.add(id);
      return { runId: `run-${id}` };
    },
  },
});
mock.module("../src/workflows/email.ts", {
  namedExports: { emailWorkflow: async () => {} },
});
let jobs: typeof import("../src/server/email/jobs");
before(async () => {
  jobs = await import("../src/server/email/jobs");
});
beforeEach(() => {
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
  recipients = [];
  cursor = null;
  complete = false;
  clock = 0;
  queries = 0;
  failLaunches = false;
  launched = new Set();
  outbox = new Map();
});
test("drain advances multiple recipient and launch pages without waiting for cron", async () => {
  recipients = Array.from({ length: 601 }, (_, i) =>
    String(i).padStart(4, "0"),
  );
  let steps = 0;
  while (true) {
    const result = await jobs.drainPublicationEmailPage();
    steps++;
    if (!result.remaining) break;
    assert.ok(
      steps < 30,
      "drain must terminate after all pending pages launch",
    );
  }
  assert.equal(launched.size, 601);
  assert.equal(steps, 25);
  assert.equal(complete, true);
  assert.equal(cursor, "0600");
});
test("a delayed launch retry keeps the drain alive until its due time", async () => {
  recipients = ["only-recipient"];
  failLaunches = true;
  assert.deepEqual(await jobs.drainPublicationEmailPage(), {
    remaining: true,
    progress: true,
  });
  assert.deepEqual(await jobs.drainPublicationEmailPage(), {
    remaining: true,
    progress: false,
  });
  assert.equal(launched.size, 0);
  clock = 60;
  failLaunches = false;
  assert.deepEqual(await jobs.drainPublicationEmailPage(), {
    remaining: false,
    progress: true,
  });
  assert.equal(launched.size, 1);
});
test("disabled email stops a drain without advancing recipient or launch state", async () => {
  process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
  assert.deepEqual(await jobs.drainPublicationEmailPage(), {
    remaining: false,
    progress: false,
  });
  assert.equal(queries, 0);
});
