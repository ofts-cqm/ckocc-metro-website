import assert from "node:assert/strict";
import { before, mock, test } from "node:test";

let accounts = [{ id: "alice", name: "Alice Player", role: "collaborator" }];
mock.module("../src/server/db/index.ts", {
  namedExports: {
    query: async (sql: string) =>
      sql.includes("FROM metro_rate_limits")
        ? { rows: [{ count: 1 }] }
        : { rows: accounts },
  },
});
mock.module("../src/server/security/index.ts", {
  namedExports: {
    abuseDigest: (value: string) => value,
    trustedClientIp: () => "127.0.0.1",
  },
});

let mentions: typeof import("../src/server/operations/mentions");
before(async () => {
  mentions = await import("../src/server/operations/mentions");
});

const request = new Request("http://localhost:3000/api/mentions");
test("selected multiword mentions resolve to active account IDs", async () => {
  const comment = "Hello @Alice Player!";
  assert.deepEqual(
    await mentions.resolveMentions({
      gameName: "Visitor",
      locale: "en-US",
      comment,
      mentions: [{ userId: "alice", start: 6, end: 19 }],
    }),
    ["alice"],
  );
  assert.equal(
    (await mentions.mentionSuggestions("Ali"))[0].name,
    "Alice Player",
  );
});

test("edited, forged and disabled mention selections fail validation", async () => {
  const base = {
    gameName: "Visitor",
    locale: "en-US" as const,
    comment: "Hi @Alice Player",
  };
  await assert.rejects(
    mentions.resolveMentions({
      ...base,
      mentions: [{ userId: "alice", start: 3, end: 9 }],
    }),
    { code: "invalid_mention" },
  );
  accounts = [];
  await assert.rejects(
    mentions.resolveMentions({
      ...base,
      mentions: [{ userId: "alice", start: 3, end: 16 }],
    }),
    { code: "invalid_mention" },
  );
  accounts = [{ id: "alice", name: "Alice Player", role: "collaborator" }];
});

test("guest allowance counts recipients and rejects an over-limit reservation", async () => {
  assert.equal(await mentions.guestMentionRemaining(request), 2);
  let reserved = 0;
  const client = {
    query: async () => ({ rows: [{ count: (reserved += 2) }] }),
  };
  await mentions.reserveGuestMentions(client as never, request, 2);
  await assert.rejects(
    mentions.reserveGuestMentions(client as never, request, 2),
    {
      code: "guest_mention_limit",
      status: 429,
    },
  );
});
