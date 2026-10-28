import type { RequestPayload, CommentPayload } from "@/lib/contracts";
import type { MapManifest } from "@/server/maps/validate";
import { PipelineError } from "@/server/operations/errors";

/** Entity-encode every punctuation character with Markdown, mention, HTML or reference meaning.
 * Request, comment, and pull request templates use it.
 */
export function plainText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/[<>@#\\`*_{}\[\]()!|~:+.\-]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
/** Flattens escaped user text into one Markdown table cell.
 * Line request rendering uses it for station rows.
 */
const cell = (s: string) => plainText(s).replaceAll("\n", " ");
/** Adds a durable operation marker to a GitHub body.
 * Issue, comment, and pull request writes use it for reconciliation.
 */
export const marker = (id: string) => `<!-- metro-operation:${id} -->`;
/** Rejects generated GitHub bodies above the provider size budget.
 * All GitHub templates pass their body through it.
 */
function bounded(body: string): string {
  if (Buffer.byteLength(body, "utf8") > 60_000)
    throw new PipelineError("generated_body_too_large", 422);
  return body;
}
/** Makes a short, inert title excerpt from submitted text.
 * Issue title rendering uses it.
 */
function excerpt(value: string, limit = 100): string {
  return Array.from(value.replace(/[\r\n\t]/g, " ").replace(/[@#]/g, ""))
    .slice(0, limit)
    .join("");
}
/** Formats a general thought or line request as an issue.
 * Request operations use it before writing to GitHub.
 */
export function requestTemplate(payload: RequestPayload, id: string) {
  const heading = `Submitted in-game name (unverified): ${plainText(payload.gameName)}\n\nLocale: ${payload.locale}`;
  if (payload.kind === "general")
    return {
      title: `Request: ${excerpt(payload.comment)}`,
      body: bounded(
        `## General thought\n\n${heading}\n\n${plainText(payload.comment)}\n\n${marker(id)}`,
      ),
      labels: ["metro-request", "type:general"],
    };
  const name =
    payload.lineName ||
    payload.lineNumber ||
    `${payload.stations[0].chineseName} – ${payload.stations.at(-1)!.chineseName}`;
  const rows = payload.stations
    .map(
      (s, i) =>
        `| ${i + 1} | ${cell(s.chineseName)} | ${cell(s.englishName ?? "")} | ${s.x} | ${s.z} | ${cell(s.dimension)} |`,
    )
    .join("\n");
  return {
    title: `${payload.operation === "add" ? "Add" : "Update"} line: ${excerpt(name)}`,
    body: bounded(
      `## Line ${payload.operation}\n\n${heading}\n\nLine name: ${plainText(payload.lineName ?? "Not supplied")}\n\nLine number: ${plainText(payload.lineNumber ?? "Not supplied")}\n\nLine type: ${payload.lineType}\n\nThe following is the proposed complete station order.\n\n| Order | Chinese name | English name | X | Z | Dimension |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n\n## Notes\n\n${plainText(payload.notes)}\n\n${marker(id)}`,
    ),
    labels: [
      "metro-request",
      "type:line-update",
      `operation:${payload.operation}`,
    ],
  };
}
/** Formats a verified or guest comment with reply context.
 * Comment operations and attribution checks use it.
 */
export function commentTemplate(
  payload: CommentPayload,
  id: string,
  verified = false,
  issueUrl?: string,
) {
  const reply = payload.replyToCommentId
    ? `In reply to [comment #${payload.replyToCommentId}](${issueUrl || ""}#issuecomment-${payload.replyToCommentId})\n\n`
    : "";
  return bounded(
    `Submitted in-game name (${verified ? "verified" : "unverified"}): ${plainText(payload.gameName)}\n\nLocale: ${payload.locale}\n\n${reply}${plainText(payload.comment)}\n\n${marker(id)}`,
  );
}
/** Formats map manifest details for human review.
 * Map update operations use it when opening a pull request.
 */
export function pullRequestTemplate(manifest: MapManifest, details: string) {
  return bounded(
    `## Map update\n\nContributor: ${plainText(manifest.contributor_display_name)}\n\n${plainText(manifest.summary)}\n\n${plainText(details)}\n\nBase map revision: \`${manifest.base_map_revision}\`\n\nMap revision: \`${manifest.map_revision}\`\n\nJSON SHA-256: \`${manifest.files.json.sha256}\`\n\nPNG SHA-256: \`${manifest.files.png.sha256}\`\n\nPlease review the image, reopen the JSON in Rail Map Painter, and confirm the base revision before merging.\n\n${manifest.selected_issue_numbers.map((n) => `Closes #${n}`).join("\n")}\n\n${marker(manifest.operation_id)}`,
  );
}
