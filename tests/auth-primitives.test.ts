import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  needsRehash,
  validPassword,
  verifyPassword,
} from "../src/server/auth/password";

test("password hashes use independent salts and preserve the exact password", async () => {
  const password = "  Metro railway passphrase  ";
  // Sequential hashes keep the test's native memory usage bounded.
  const first = await hashPassword(password);
  const second = await hashPassword(password);

  assert.match(first, /^\$argon2id\$v=19\$/);
  assert.notEqual(
    first,
    second,
    "Hashing identical passwords must generate a new salt",
  );
  assert.notEqual(
    first.split("$")[4],
    second.split("$")[4],
    "The encoded salts must differ",
  );
  assert.equal(await verifyPassword({ hash: first, password }), true);
  assert.equal(await verifyPassword({ hash: second, password }), true);
  assert.equal(
    await verifyPassword({ hash: first, password: password.trim() }),
    false,
    "Whitespace is part of the password",
  );
  assert.equal(
    await verifyPassword({
      hash: first,
      password: "a different metro passphrase",
    }),
    false,
  );
  assert.equal(
    await verifyPassword({ hash: "malformed-password-hash", password }),
    false,
  );
  assert.equal(needsRehash(first), false);
  assert.equal(needsRehash(second), false);
});

test("password bounds reject invalid values without trimming or truncation", () => {
  assert.equal(validPassword("x".repeat(MIN_PASSWORD_LENGTH)), true);
  assert.equal(validPassword("x".repeat(MAX_PASSWORD_LENGTH)), true);
  for (const password of [
    "",
    "x".repeat(MIN_PASSWORD_LENGTH - 1),
    "x".repeat(MAX_PASSWORD_LENGTH + 1),
  ]) {
    assert.equal(validPassword(password), false);
    assert.throws(() => hashPassword(password), /12 to 128/);
  }
  for (const password of [
    null,
    undefined,
    123456789012,
    {},
    ["a long password"],
  ]) {
    assert.equal(validPassword(password), false);
  }
});

test("rehash policy upgrades older or weaker parameters without downgrading stronger hashes", () => {
  // These PHC strings are inspected only for upgrade policy; no expensive verification occurs.
  const phc = (
    algorithm: string,
    version: number,
    memory: number,
    iterations: number,
    parallelism: number,
  ) =>
    `$${algorithm}$v=${version}$m=${memory},t=${iterations},p=${parallelism}$c29tZXJhbmRvbXNhbHQ$YW5leGFtcGxlZGlnZXN0`;

  assert.equal(needsRehash(phc("argon2id", 19, 19_456, 2, 1)), false);
  assert.equal(needsRehash(phc("argon2id", 19, 65_536, 3, 2)), false);
  for (const encoded of [
    phc("argon2id", 19, 19_455, 2, 1),
    phc("argon2id", 19, 19_456, 1, 1),
    phc("argon2id", 19, 19_456, 2, 0),
    phc("argon2id", 16, 19_456, 2, 1),
    phc("argon2i", 19, 19_456, 2, 1),
    "$scrypt$legacy-format",
    "",
  ]) {
    assert.equal(
      needsRehash(encoded),
      true,
      `Expected an upgrade for ${encoded}`,
    );
  }
});
