import assert from "node:assert/strict";
import test from "node:test";
import {
  BootstrapError,
  bootstrapFailureMessage,
} from "../scripts/lib/bootstrap-errors";

test("bootstrap explains input failures without including submitted values", () => {
  for (const [reason, expected] of [
    ["terminal", /interactive terminal/],
    ["email", /valid email/],
    ["name", /display name/],
    ["password", /8–128/],
    ["confirmation", /Passwords do not match/],
    ["configured", /DATABASE_URL is missing/],
    ["existing", /administrator already exists/],
  ] as const) {
    const error = new BootstrapError(reason);
    error.message = "a password or other sensitive value";
    const message = bootstrapFailureMessage(error, "reading account details");
    assert.match(message, expected);
    assert.doesNotMatch(message, /sensitive value/);
  }
});

test("bootstrap maps database errors to safe, actionable diagnostics", () => {
  const sensitive = "postgresql://user:secret@host/db";
  for (const [code, expected] of [
    ["ECONNREFUSED", /db:local:start/],
    ["28P01", /database credentials/],
    ["42P01", /db:migrate/],
    ["23505", /already uses this email/],
    ["42501", /lacks permission/],
  ] as const) {
    const message = bootstrapFailureMessage(
      { code, message: sensitive, detail: sensitive, stack: sensitive },
      "saving the administrator",
    );
    assert.match(message, expected);
    assert.match(message, /saving the administrator/);
    assert.equal(message.includes(sensitive), false);
  }
});

test("unknown errors keep their stage but withhold arbitrary provider data", () => {
  for (const error of [
    new Error("secret password"),
    { code: "secret password", message: "secret password" },
    { code: "toString" },
    "secret password",
    null,
  ]) {
    const message = bootstrapFailureMessage(error, "hashing the password");
    assert.match(message, /hashing the password/);
    assert.match(message, /details were withheld/);
    assert.doesNotMatch(message, /secret password/);
  }
});
