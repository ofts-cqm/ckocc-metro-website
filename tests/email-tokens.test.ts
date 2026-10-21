import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  EMAIL_TOKEN_PATTERN,
  tokenDigest,
  tokenValue,
} from "../src/server/email/tokens";

test("email token derivation is stable, secret-bound, unguessable from its public id, and hashed for storage", () => {
  const original = process.env.EMAIL_TOKEN_SECRET;
  try {
    process.env.EMAIL_TOKEN_SECRET =
      "email-token-test-secret-32-characters-minimum";
    const id = randomUUID();
    const token = tokenValue(id);
    assert.match(token, EMAIL_TOKEN_PATTERN);
    assert.equal(tokenValue(id), token);
    assert.notEqual(tokenValue(randomUUID()), token);
    assert.match(tokenDigest(token), /^[a-f0-9]{64}$/);
    assert.notEqual(tokenDigest(token), token);
    process.env.EMAIL_TOKEN_SECRET =
      "different-token-test-secret-32-characters-minimum";
    assert.notEqual(tokenValue(id), token);
    process.env.EMAIL_TOKEN_SECRET = "short";
    assert.throws(() => tokenValue(id), /not configured/);
  } finally {
    if (original === undefined) delete process.env.EMAIL_TOKEN_SECRET;
    else process.env.EMAIL_TOKEN_SECRET = original;
  }
});
