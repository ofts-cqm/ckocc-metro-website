export type Locale = "en-US" | "zh-CN" | "zh-HK";
export type LocalePath = "en-us" | "zh-cn" | "zh-hk";
export type LineType =
  | "double-track-blue-ice"
  | "single-track-blue-ice"
  | "double-track-rail"
  | "single-track-rail"
  | "other";
export type Station = {
  chineseName: string;
  englishName: string | null;
  x: number;
  z: number;
  dimension: string;
};
export type GeneralRequest = {
  kind: "general";
  gameName: string;
  locale: Locale;
  comment: string;
};
export type LineRequest = {
  kind: "line-update";
  gameName: string;
  locale: Locale;
  lineName: string | null;
  lineNumber: string | null;
  lineType: LineType;
  operation: "add" | "update";
  stations: Station[];
  notes: string;
};
export type RequestPayload = GeneralRequest | LineRequest;
export type CommentPayload = {
  gameName: string;
  locale: Locale;
  comment: string;
};
export type IssueSummary = {
  number: number;
  title: string;
  state: "open" | "closed";
  kind: RequestPayload["kind"] | "unknown";
  gameName: string | null;
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
  labels: string[];
  url: string;
  locked: boolean;
};
export type IssueDetail = IssueSummary & {
  body: string;
  request?: RequestPayload | null;
};
export type IssueComment = {
  id: number;
  body: string;
  gameName: string | null;
  author: string;
  createdAt: string;
  updatedAt: string;
  unverified: boolean;
};
export type PublishedMap = {
  revision: string;
  commitSha: string;
  imageUrl: string;
  overviewUrl?: string;
  publishedAt: string;
  width: number;
  height: number;
  summary?: string;
};
export type UploadAsset = {
  pathname: string;
  url?: string;
  bytes?: number;
  sha256?: string;
};
export type EditSession = {
  id: string;
  baseCommit: string;
  baseMapRevision: string;
  createdAt: string;
  expiresAt: string;
  status: string;
  sourceUrl: string;
  assets?: { json?: UploadAsset; png?: UploadAsset };
};
export type OperationStatus =
  | "accepted"
  | "draft"
  | "uploaded"
  | "validating"
  | "creating_pr"
  | "awaiting_review"
  | "needs_reconciliation"
  | "merged"
  | "closed_unmerged"
  | "published"
  | "succeeded"
  | "failed"
  | "outcome_unknown";
export type OperationView = {
  id: string;
  kind: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  result?: Record<string, unknown>;
  errorCode?: string | null;
  retryAt?: string | null;
};
export type UpdateSummary = {
  id: string;
  status: OperationStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
  baseMapRevision: string;
  prNumber?: number | null;
  prUrl?: string | null;
  errorCode?: string | null;
};
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "collaborator" | "admin";
};
export type ApiErrorBody = {
  error: { code: string; message: string; fields?: Record<string, string[]> };
};
