import type { LocalePath } from "@/lib/contracts";
import { catalogs } from "@/lib/i18n/catalogs";

const words = {
  "en-us": {
    verification: "Verify your email address",
    verify: "Confirm email address",
    verificationBody:
      "Confirm this email address for your CKOCC Metro account. This link expires in one hour. If you did not request this message, you can ignore it.",
    reply: "replied to you",
    mention: "mentioned you",
    "line-add": "requested a new metro line",
    "line-update": "requested a metro line update",
    open: "View discussion",
    settings: "Email preferences",
    unsubscribe: "Disable email notifications",
    actor: "Someone",
    notifications: "View notifications",
    dailyLimit:
      "To avoid sending you too many emails, you won’t receive any more notification emails today. Please check your website notifications for new messages.",
  },
  "zh-cn": {
    verification: "验证您的电子邮箱",
    verify: "确认电子邮箱",
    verificationBody:
      "请确认此邮箱用于您的 CKOCC Metro 账户。此链接将在一小时后失效。如果您没有请求此邮件，可以忽略。",
    reply: "回复了您",
    mention: "提及了您",
    "line-add": "请求新增地铁线路",
    "line-update": "请求更新地铁线路",
    open: "查看讨论",
    settings: "邮件偏好设置",
    unsubscribe: "关闭邮件通知",
    actor: "有人",
    notifications: "查看通知",
    dailyLimit:
      "为避免邮件过多，您今天将不再收到新的通知邮件。请前往网站通知查看新消息。",
  },
  "zh-hk": {
    verification: "驗證您的電郵地址",
    verify: "確認電郵地址",
    verificationBody:
      "請確認此電郵地址用於您的 CKOCC Metro 帳戶。此連結將在一小時後失效。如果您沒有要求此郵件，可以忽略。",
    reply: "回覆了您",
    mention: "提及了您",
    "line-add": "要求新增地鐵路綫",
    "line-update": "要求更新地鐵路綫",
    open: "查看討論",
    settings: "電郵偏好設定",
    unsubscribe: "關閉電郵通知",
    actor: "有人",
    notifications: "查看通知",
    dailyLimit:
      "為避免電郵過多，您今天將不再收到新的通知電郵。請前往網站通知查看新訊息。",
  },
};

/** Normalizes a stored locale to a supported email catalog.
 * Job creation and rendering use it.
 */
export function emailLocale(value: string): LocalePath {
  const normalized = value.toLowerCase();
  return normalized === "zh-cn" || normalized === "zh-hk"
    ? normalized
    : "en-us";
}
/** Escapes untrusted values before adding them to HTML.
 * The email renderer uses it for links and submitted text.
 */
export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

/** Truncates an optional submitted field by character count.
 * Notification content rendering uses it for email summaries.
 */
function boundedText(value: unknown, limit: number): string {
  return typeof value === "string"
    ? Array.from(value).slice(0, limit).join("")
    : "";
}

/** Render only public submission fields, never internal operation metadata.
 * The email renderer calls it for operation notifications.
 */
export function notificationContent(
  source: Record<string, unknown>,
  locale: string,
): string {
  if (source.kind !== "line-update") return boundedText(source.comment, 5000);
  const labels = catalogs[emailLocale(locale)];
  const lineTypes: Record<string, string> = {
    "double-track-blue-ice": labels.double_track_blue_ice,
    "single-track-blue-ice": labels.single_track_blue_ice,
    "double-track-rail": labels.double_track_rail,
    "single-track-rail": labels.single_track_rail,
    other: labels.other,
  };
  const fields = [
    [labels.lineName, boundedText(source.lineName, 120)],
    [labels.lineNumber, boundedText(source.lineNumber, 32)],
    [labels.lineType, lineTypes[String(source.lineType)] || ""],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);
  const stations = Array.isArray(source.stations)
    ? source.stations.slice(0, 200).flatMap((value: unknown, index: number) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return [];
        const station = value as Record<string, unknown>;
        const names = [
          boundedText(station.chineseName, 120),
          boundedText(station.englishName, 120),
        ]
          .filter(Boolean)
          .join(" / ");
        const coordinates = ["x", "z"].flatMap((axis) =>
          Number.isSafeInteger(station[axis])
            ? [`${axis.toUpperCase()}: ${station[axis]}`]
            : [],
        );
        const dimension = boundedText(station.dimension, 128);
        return [
          `${index + 1}. ${names}${coordinates.length ? ` (${coordinates.join(", ")})` : ""}${dimension ? ` — ${labels.dimension}: ${dimension}` : ""}`,
        ];
      })
    : [];
  const sections = [fields.join("\n")];
  if (stations.length)
    sections.push(`${labels.stationTitle}:\n${stations.join("\n")}`);
  const notes = boundedText(source.notes, 5000);
  if (notes) sections.push(`${labels.notes}:\n${notes}`);
  return sections.filter(Boolean).join("\n\n");
}

/** Builds localized text and HTML verification or alert mail.
 * The email sender calls it just before SES submission.
 */
export function renderEmail(input: {
  kind: "notification" | "verification";
  locale: string;
  origin: string;
  payload: Record<string, unknown>;
  token?: string;
  unsubscribeToken?: string;
  dailyLimitReached?: boolean;
}) {
  const locale = emailLocale(input.locale);
  const text = words[locale];
  const base = `${input.origin}/${locale}`;
  if (input.kind === "verification") {
    const link = `${base}/email/verify#token=${encodeURIComponent(input.token!)}`;
    return {
      subject: `CKOCC Metro — ${text.verification}`,
      text: `${text.verificationBody}\n\n${text.verify}: ${link}`,
      html: `<p>${text.verificationBody}</p><p><a href="${escapeHtml(link)}">${text.verify}</a></p>`,
    };
  }
  const kind = String(input.payload.notificationKind);
  const action =
    text[kind as "reply" | "mention" | "line-add" | "line-update"] ||
    text.mention;
  const sender = String(input.payload.sender || text.actor)
    .replace(/[\r\n]/g, " ")
    .slice(0, 120);
  const summary = `${sender} ${action}`;
  const issue = Number(input.payload.issueNumber);
  const link = `${base}/issues/${Number.isSafeInteger(issue) && issue > 0 ? issue : ""}`;
  const settings = `${base}/settings`;
  const unsubscribe = `${base}/email/unsubscribe#token=${encodeURIComponent(input.unsubscribeToken!)}`;
  const source = input.payload.source;
  const body =
    source && typeof source === "object" && !Array.isArray(source)
      ? notificationContent(source as Record<string, unknown>, locale)
      : "";
  const notifications = `${base}?notifications=open`;
  const limitText = input.dailyLimitReached
    ? `\n\n${text.dailyLimit}\n${text.notifications}: ${notifications}`
    : "";
  const limitHtml = input.dailyLimitReached
    ? `<p>${text.dailyLimit} <a href="${escapeHtml(notifications)}">${text.notifications}</a></p>`
    : "";
  return {
    subject: `CKOCC Metro — ${summary}`,
    text: `${summary}${body ? `\n\n${body}` : ""}\n\n${text.open}: ${link}${limitText}\n\n${text.settings}: ${settings}\n${text.unsubscribe}: ${unsubscribe}`,
    html: `<p>${escapeHtml(summary)}</p>${body ? `<div style="white-space: pre-wrap; overflow-wrap: anywhere">${escapeHtml(body).replace(/\r\n?|\n/g, "<br>")}</div>` : ""}<p><a href="${escapeHtml(link)}">${text.open}</a></p>${limitHtml}<p><a href="${escapeHtml(settings)}">${text.settings}</a> · <a href="${escapeHtml(unsubscribe)}">${text.unsubscribe}</a></p>`,
  };
}
