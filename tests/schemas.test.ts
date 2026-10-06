import assert from "node:assert/strict";
import test from "node:test";
import {
  commentSchema,
  generalRequestSchema,
  lineRequestSchema,
  requestSchema,
  stationSchema,
  updateSchema,
} from "../src/lib/schemas";

const station = { chineseName: "可可西里站", x: -128, z: 240 };
const line = {
  kind: "line-update",
  gameName: "MetroBuilder",
  locale: "zh-HK",
  lineType: "double-track-blue-ice",
  operation: "add",
  stations: [station],
};
const general = {
  kind: "general",
  gameName: "MetroBuilder",
  locale: "en-US",
  comment: "Could we add a station near the harbour?",
};

test("stations default missing or blank dimensions to overworld", () => {
  assert.equal(stationSchema.parse(station).dimension, "overworld");
  for (const dimension of [undefined, "", "   "]) {
    assert.equal(
      stationSchema.parse({ ...station, dimension }).dimension,
      "overworld",
    );
  }
});

test("custom dimension names retain spelling, case, spaces, and namespace punctuation", () => {
  for (const dimension of [
    "server:moon",
    "Resource World",
    "資源界",
    "Custom:UPPER_Case",
    "Moon / Level 2",
  ]) {
    assert.equal(
      stationSchema.parse({ ...station, dimension }).dimension,
      dimension,
    );
  }
  assert.equal(
    stationSchema.parse({ ...station, dimension: "  Resource World  " })
      .dimension,
    "Resource World",
  );
  assert.equal(
    stationSchema.safeParse({ ...station, dimension: "custom\u0000world" })
      .success,
    false,
  );
  assert.equal(
    stationSchema.safeParse({ ...station, dimension: "x".repeat(129) }).success,
    false,
  );
});

test("English station names are optional while Chinese names remain required", () => {
  assert.equal(stationSchema.parse(station).englishName, null);
  for (const englishName of [undefined, null, "", "   "]) {
    assert.equal(
      stationSchema.parse({ ...station, englishName }).englishName,
      null,
    );
  }
  assert.equal(
    stationSchema.parse({ ...station, englishName: "  Kokoxili  " })
      .englishName,
    "Kokoxili",
  );
  for (const chineseName of [undefined, null, "", "   "]) {
    assert.equal(
      stationSchema.safeParse({ ...station, chineseName }).success,
      false,
    );
  }
  // A supplementary CJK character occupies two UTF-16 code units but is one Unicode character.
  assert.equal(
    stationSchema.safeParse({ ...station, chineseName: "𠀋".repeat(120) })
      .success,
    true,
  );
  assert.equal(
    stationSchema.safeParse({ ...station, chineseName: "𠀋".repeat(121) })
      .success,
    false,
  );
});

test("coordinates accept signed safe integers and reject fractions or nonfinite values", () => {
  const parsed = stationSchema.parse({
    ...station,
    x: Number.MIN_SAFE_INTEGER,
    z: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(parsed.x, Number.MIN_SAFE_INTEGER);
  assert.equal(parsed.z, Number.MAX_SAFE_INTEGER);
  for (const value of [
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "12",
  ]) {
    assert.equal(
      stationSchema.safeParse({ ...station, x: value }).success,
      false,
    );
    assert.equal(
      stationSchema.safeParse({ ...station, z: value }).success,
      false,
    );
  }
});

test("line identifiers remain optional text, including noninteger identifiers and leading zeroes", () => {
  const unnamed = lineRequestSchema.parse(line);
  assert.equal(unnamed.lineName, null);
  assert.equal(unnamed.lineNumber, null);
  for (const lineNumber of ["01", "2A", "7.5", "Airport"]) {
    assert.equal(
      lineRequestSchema.parse({ ...line, lineNumber }).lineNumber,
      lineNumber,
    );
  }
  assert.equal(
    lineRequestSchema.safeParse({ ...line, lineNumber: 7.5 }).success,
    false,
  );
  assert.equal(
    lineRequestSchema.parse({ ...line, lineName: "", lineNumber: " " })
      .lineNumber,
    null,
  );
  assert.equal(
    lineRequestSchema.safeParse({ ...line, stations: [] }).success,
    false,
  );
  const ordered = lineRequestSchema.parse({
    ...line,
    stations: [
      { ...station, chineseName: "終點" },
      { ...station, chineseName: "起點" },
    ],
  });
  assert.deepEqual(
    ordered.stations.map((item) => item.chineseName),
    ["終點", "起點"],
  );
});

test("only supported locales and request types are accepted", () => {
  for (const locale of ["en-US", "zh-CN", "zh-HK"]) {
    assert.equal(requestSchema.safeParse({ ...general, locale }).success, true);
    assert.equal(requestSchema.safeParse({ ...line, locale }).success, true);
  }
  assert.equal(
    requestSchema.safeParse({ ...general, locale: "zh-TW" }).success,
    false,
  );
  assert.equal(
    requestSchema.safeParse({ ...general, kind: "admin-command" }).success,
    false,
  );
  assert.equal(
    lineRequestSchema.safeParse({ ...line, lineType: "unknown" }).success,
    false,
  );
});

test("write payloads reject unexpected fields and client-supplied authority", () => {
  assert.equal(
    generalRequestSchema.safeParse({
      ...general,
      repository: "other/repository",
    }).success,
    false,
  );
  assert.equal(
    requestSchema.safeParse({ ...general, role: "admin" }).success,
    false,
  );
  assert.equal(
    lineRequestSchema.safeParse({ ...line, ownerId: "someone-else" }).success,
    false,
  );
  assert.equal(stationSchema.safeParse({ ...station, y: 64 }).success, false);
  assert.equal(
    commentSchema.safeParse({
      gameName: "MetroBuilder",
      locale: "zh-CN",
      comment: "已完成！",
      authorId: "admin",
    }).success,
    false,
  );
  assert.equal(
    updateSchema.safeParse({
      editSessionId: "835c5b58-461a-4dc6-b091-d6a99d187b6e",
      summary: "Added the harbour station",
      baseCommit: "attacker-selected-base",
    }).success,
    false,
  );
});
