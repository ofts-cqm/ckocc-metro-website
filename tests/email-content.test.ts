import assert from "node:assert/strict";
import { test } from "node:test";
import {
  notificationContent,
  renderEmail,
} from "../src/server/email/templates";

function notification(
  source: Record<string, unknown>,
  notificationKind = "mention",
  locale = "en-us",
  dailyLimitReached = false,
) {
  return renderEmail({
    kind: "notification",
    locale,
    origin: "https://metro.example",
    payload: { notificationKind, source, sender: "Builder", issueNumber: 7 },
    unsubscribeToken: "opaque",
    dailyLimitReached,
  });
}

test("reply, mention and general-thought emails include the actual submitted message", () => {
  for (const kind of ["reply", "mention"]) {
    const email = notification({ comment: "4321\nSecond line" }, kind);
    assert.match(email.text, /\n\n4321\nSecond line\n\n/);
    assert.match(email.html, /4321<br>Second line/);
    assert.doesNotMatch(email.subject, /4321/);
  }
  assert.match(
    notification({ kind: "general", comment: "A useful general thought" }).text,
    /A useful general thought/,
  );
});

test("notification bodies escape user HTML and preserve plain text without exposing metadata", () => {
  const comment =
    '<img src=x onerror="alert(1)"> & [link](javascript:evil)\r\n@Person';
  const email = notification({
    comment,
    mentions: [{ userId: "private-user-id", start: 0, end: 1 }],
    receiptToken: "internal-receipt",
  });
  assert.ok(email.text.includes(comment));
  assert.match(
    email.html,
    /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp;/,
  );
  assert.match(email.html, /<br>@Person/);
  assert.doesNotMatch(email.html, /<img|<script|href="javascript:/);
  assert.doesNotMatch(
    email.text + email.html,
    /private-user-id|internal-receipt/,
  );
});

test("line addition and update emails show line details, complete station order and notes", () => {
  const source = {
    kind: "line-update",
    lineName: "Central & West",
    lineNumber: "2A",
    lineType: "double-track-blue-ice",
    stations: [
      {
        chineseName: "中央",
        englishName: "Central",
        x: 0,
        z: -25,
        dimension: "overworld",
      },
      {
        chineseName: "西站",
        englishName: null,
        x: 180,
        z: 42,
        dimension: "server:moon",
      },
    ],
    notes: "Connect the western district.\nKeep the existing interchange.",
  };
  for (const kind of ["line-add", "line-update"]) {
    const email = notification(source, kind);
    assert.match(email.text, /Line name: Central & West/);
    assert.match(email.text, /Line number or identifier: 2A/);
    assert.match(email.text, /Line type: Double-track blue ice/);
    assert.match(
      email.text,
      /1\. 中央 \/ Central \(X: 0, Z: -25\) — Dimension: overworld/,
    );
    assert.match(
      email.text,
      /2\. 西站 \(X: 180, Z: 42\) — Dimension: server:moon/,
    );
    assert.match(
      email.text,
      /Connect the western district\.\nKeep the existing interchange\./,
    );
    assert.match(email.html, /Central &amp; West/);
  }
  assert.match(notificationContent(source, "zh-CN"), /线路类型: 双线蓝冰/);
  assert.match(notificationContent(source, "zh-HK"), /路綫類型: 雙綫藍冰/);
});

test("all schema-allowed text and station rows fit without shortening valid submissions", () => {
  const comment = "🚇".repeat(5000);
  assert.equal(notificationContent({ comment }, "en-us"), comment);
  const stations = Array.from({ length: 200 }, (_, index) => ({
    chineseName: `Station ${index + 1}`,
    englishName: null,
    x: index,
    z: -index,
    dimension: "overworld",
  }));
  const content = notificationContent(
    { kind: "line-update", stations, notes: comment },
    "en-us",
  );
  assert.match(content, /200\. Station 200/);
  assert.ok(content.endsWith(comment));
});

test("only the final daily notification has a localized limit notice and inbox link", () => {
  for (const [locale, notice] of [
    ["en-us", "you won’t receive any more notification emails today"],
    ["zh-cn", "您今天将不再收到新的通知邮件"],
    ["zh-hk", "您今天將不再收到新的通知電郵"],
  ]) {
    const final = notification({ comment: "4321" }, "reply", locale, true);
    assert.ok(final.text.includes(notice));
    assert.ok(final.html.includes(notice));
    assert.ok(
      final.text.includes(`https://metro.example/${locale}?notifications=open`),
    );
    assert.ok(
      final.html.includes(
        `href="https://metro.example/${locale}?notifications=open"`,
      ),
    );
    const earlier = notification({ comment: "4321" }, "reply", locale);
    assert.ok(!earlier.text.includes(notice));
    assert.ok(!earlier.html.includes(notice));
    assert.doesNotMatch(earlier.text + earlier.html, /notifications=open/);
  }
});

test("verification and legacy queued emails remain readable without source content", () => {
  const verification = renderEmail({
    kind: "verification",
    locale: "en-us",
    origin: "https://metro.example",
    payload: { source: { comment: "4321" } },
    token: "verify-token",
    dailyLimitReached: true,
  });
  assert.doesNotMatch(
    verification.text + verification.html,
    /4321|notifications=open|any more notification/,
  );
  const legacy = renderEmail({
    kind: "notification",
    locale: "en-us",
    origin: "https://metro.example",
    payload: { notificationKind: "reply", sender: "Builder", issueNumber: 7 },
    unsubscribeToken: "opaque",
  });
  assert.match(legacy.text, /Builder replied to you/);
  assert.doesNotMatch(
    legacy.text + legacy.html,
    /undefined|null|\[object Object\]/,
  );
});
