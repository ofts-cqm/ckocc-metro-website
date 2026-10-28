import { z } from "zod";

/** Builds trimmed text validation with control-character and length limits.
 * Request, comment, and update payload schemas reuse it at the API boundary. */
const safeText = (max: number, required = true) =>
  z
    .string()
    .trim()
    .refine(
      (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
      "invalid_text",
    )
    .refine((value) => Array.from(value).length <= max, "too_long")
    .refine((value) => !required || value.length > 0, "required");
/** Restricts short form fields to a single line during API validation. */
const singleLine = (max: number) =>
  safeText(max).refine((value) => !/[\r\n\t]/u.test(value), "invalid_text");
/** Converts empty optional fields to null before single-line validation.
 * Line and station forms use it before creating their request payloads. */
const optionalText = (max: number) =>
  z.preprocess(
    (value) =>
      value === undefined ||
      value === null ||
      (typeof value === "string" && !value.trim())
        ? null
        : value,
    singleLine(max).nullable(),
  );

export const localeSchema = z.enum(["en-US", "zh-CN", "zh-HK"]);
export const lineTypeSchema = z.enum([
  "double-track-blue-ice",
  "single-track-blue-ice",
  "double-track-rail",
  "single-track-rail",
  "other",
]);
export const stationSchema = z
  .object({
    chineseName: singleLine(120),
    englishName: optionalText(120),
    x: z.number().int().refine(Number.isSafeInteger, "invalid_coordinate"),
    z: z.number().int().refine(Number.isSafeInteger, "invalid_coordinate"),
    dimension: z.preprocess(
      (value) =>
        value === undefined || (typeof value === "string" && !value.trim())
          ? "overworld"
          : value,
      singleLine(128),
    ),
  })
  .strict();
const common = { gameName: singleLine(64), locale: localeSchema };
const mentionsSchema = z
  .array(
    z
      .object({
        userId: z.string().min(1).max(128),
        start: z.number().int().min(0).refine(Number.isSafeInteger),
        end: z.number().int().positive().refine(Number.isSafeInteger),
      })
      .strict(),
  )
  .max(20)
  .optional();
export const generalRequestSchema = z
  .object({
    ...common,
    kind: z.literal("general"),
    comment: safeText(5000),
    mentions: mentionsSchema,
  })
  .strict();
export const lineRequestSchema = z
  .object({
    ...common,
    kind: z.literal("line-update"),
    lineName: optionalText(120),
    lineNumber: optionalText(32),
    lineType: lineTypeSchema,
    operation: z.enum(["add", "update"]),
    notifyAdmins: z.boolean().default(true),
    stations: z.array(stationSchema).min(1).max(200),
    notes: safeText(5000, false).default(""),
  })
  .strict();
export const requestSchema = z.discriminatedUnion("kind", [
  generalRequestSchema,
  lineRequestSchema,
]);
export const commentSchema = z
  .object({
    ...common,
    comment: safeText(5000),
    replyToCommentId: z
      .number()
      .int()
      .positive()
      .refine(Number.isSafeInteger)
      .optional(),
    mentions: mentionsSchema,
  })
  .strict();
export const updateSchema = z
  .object({
    editSessionId: z.string().uuid(),
    summary: singleLine(160),
    details: safeText(5000, false).default(""),
    issueNumbers: z
      .array(z.number().int().positive())
      .max(50)
      .default([])
      .transform((values) => [...new Set(values)]),
  })
  .strict();
export const receiptTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,128}$/, "invalid_receipt");
export const idempotencyKeySchema = z.string().uuid();
export const publicSubmissionSchema = z.object({
  challengeToken: z.string().max(2048),
  receiptToken: receiptTokenSchema,
});
