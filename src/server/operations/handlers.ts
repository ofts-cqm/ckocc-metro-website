import { randomUUID, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { after } from "next/server";
import {
  requestSchema,
  commentSchema,
  publicSubmissionSchema,
  idempotencyKeySchema,
  updateSchema,
} from "@/lib/schemas";
import type { PublishedMap, UpdateSummary } from "@/lib/contracts";
import { readJson, json, errorResponse } from "@/server/http";
import {
  requireUser,
  requireAdmin,
  optionalUser,
} from "@/server/auth/authorize";
import {
  enforceSameOrigin,
  requireAnonymousWrite,
  enforceRateLimits,
  pruneSecurityRecords,
} from "@/server/security";
import { query, transaction } from "@/server/db";
import {
  listIssues,
  issueDetail,
  issueComments,
  assertEligibleIssue,
} from "@/server/github/issues";
import { requestTemplate, commentTemplate } from "@/server/github/templates";
import {
  repositoryConfig,
  githubConfigured,
  readFileAt,
  MAP_PATHS,
} from "@/server/github/client";
import {
  MAP_LIMITS,
  sha256,
  parseManifest,
  validatePng,
} from "@/server/maps/validate";
import {
  createEditSession,
  ownedEditSession,
  sessionView,
  assertFresh,
  resolveMapBase,
} from "@/server/maps/sessions";
import { publishedMap } from "@/server/maps/publication";
import {
  reserveUpload,
  completeUpload,
  handleStagingUpload,
  cleanupStaging,
  readStaged,
  publicationStorageConfigured,
  type UploadRecord,
} from "@/server/storage/staging";
import type { HandleUploadBody } from "@vercel/blob/client";
import {
  acceptOperation,
  getOperation,
  operationView,
  sameDigest,
  retryOperation,
  type Operation,
} from "./store";
import { launchOperation, repairOutbox } from "./outbox";
import { PipelineError, safeErrorCode } from "./errors";
import type { UpdateInput } from "./update";

export const route =
  (
    fn: (
      request: Request,
      context?: { params: Promise<Record<string, string>> },
    ) => Promise<Response>,
  ) =>
  async (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ) => {
    try {
      return await fn(request, context);
    } catch (error) {
      return errorResponse(error);
    }
  };
const uuid = z.string().uuid();
const key = (request: Request) =>
  idempotencyKeySchema.parse(request.headers.get("Idempotency-Key"));
const page = (request: Request) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(new URL(request.url).searchParams.get("page") ?? 1);
async function param(
  context: { params: Promise<Record<string, string>> } | undefined,
  name: string,
) {
  const values = await context?.params;
  return values?.[name] ?? "";
}
const issueNumber = async (
  context: { params: Promise<Record<string, string>> } | undefined,
) =>
  z.coerce
    .number()
    .int()
    .positive()
    .parse(await param(context, "number"));

async function queueReadReconciliation() {
  const recent = await query(
    "SELECT id FROM metro_operations WHERE kind='sync' AND created_at>now()-interval '60 seconds' LIMIT 1",
  );
  if (recent.rowCount) return;
  const operation = await acceptOperation({
    kind: "sync",
    scope: "read:sync",
    key: new Date().toISOString().slice(0, 16),
    // Pull-request status can be refreshed while image publication is still being configured.
    payload: { publication: publicationStorageConfigured() },
    authorize: async () => undefined,
  });
  await launchOperation(operation.id);
}

function scheduleReadReconciliation() {
  if (!process.env.DATABASE_URL || !githubConfigured()) return;
  // Serving saved data must not depend on a workflow launch succeeding.
  after(async () => {
    try {
      await queueReadReconciliation();
    } catch (error) {
      console.error("Read reconciliation could not be scheduled", {
        code: safeErrorCode(error),
      });
    }
  });
}

async function bootstrapMapResponse() {
  try {
    const bootstrap = JSON.parse(
      await readFile(
        path.join(process.cwd(), "public/maps/bootstrap.json"),
        "utf8",
      ),
    ) as PublishedMap;
    return json({ map: bootstrap, source: "bootstrap" });
  } catch {
    return json({ map: null });
  }
}

export const getMap = route(async () => {
  if (!process.env.DATABASE_URL) return bootstrapMapResponse();
  let map: PublishedMap | null = null;
  try {
    map = await publishedMap();
  } catch (error) {
    if (
      !(error instanceof PipelineError) ||
      error.code !== "service_not_configured"
    )
      throw error;
  }
  scheduleReadReconciliation();
  // Database setup alone does not replace the approved starter map with an empty publication.
  return map ? json({ map }) : bootstrapMapResponse();
});

export const getIssues = route(async (request) => {
  const search = new URL(request.url).searchParams;
  const state = z.enum(["open", "closed"]).parse(search.get("state") || "open");
  const kind = search.has("kind")
    ? z.enum(["general", "line-update"]).parse(search.get("kind"))
    : undefined;
  if (!process.env.DATABASE_URL)
    return json({
      issues: [],
      page: page(request),
      hasMore: false,
      configured: false,
    });
  return json(await listIssues(page(request), state, kind));
});
export const getIssue = route(async (_request, context) =>
  json({ issue: await issueDetail(await issueNumber(context)) }),
);
export const getComments = route(async (request, context) =>
  json(await issueComments(await issueNumber(context), page(request))),
);

async function publicInput(request: Request) {
  enforceSameOrigin(request);
  const raw = z.record(z.string(), z.unknown()).parse(await readJson(request));
  const security = publicSubmissionSchema.parse(raw);
  const {
    challengeToken: _challenge,
    receiptToken: _receipt,
    ...payload
  } = raw;
  return { ...security, payload, key: key(request) };
}
export const postRequest = route(async (request) => {
  const input = await publicInput(request);
  const user = await optionalUser(request);
  // Bind the name before validation and digesting, including for tampered or restored drafts.
  const payload = requestSchema.parse(
    user ? { ...input.payload, gameName: user.name } : input.payload,
  );
  requestTemplate(payload, "00000000-0000-0000-0000-000000000000");
  const operation = await acceptOperation({
    kind: "request",
    scope: user ? `user:${user.id}:request` : "public:request",
    actorId: user?.id,
    key: input.key,
    receiptToken: input.receiptToken,
    payload,
    authorize: () =>
      requireAnonymousWrite(
        request,
        "request",
        input.challengeToken,
        input.key,
      ),
  });
  await launchOperation(operation.id);
  return json(
    { operation: operationView(operation), receiptToken: input.receiptToken },
    202,
  );
});
export const postCloseIssue = route(async (request, context) => {
  enforceSameOrigin(request);
  const user = await requireUser(request);
  const number = await issueNumber(context);
  z.object({})
    .strict()
    .parse(await readJson(request, 1024));
  const operation = await acceptOperation({
    kind: "close-issue",
    scope: `user:${user.id}:close-issue:${number}`,
    key: key(request),
    actorId: user.id,
    payload: { issueNumber: number },
    authorize: async () => {
      await enforceRateLimits([
        { key: `close-issue:${user.id}`, max: 60, seconds: 3600 },
      ]);
      await assertEligibleIssue(number);
    },
  });
  await launchOperation(operation.id);
  return json({ operation: operationView(operation) }, 202);
});
export const postComment = route(async (request, context) => {
  const number = await issueNumber(context);
  const input = await publicInput(request);
  const user = await optionalUser(request);
  const payload = commentSchema.parse(
    user ? { ...input.payload, gameName: user.name } : input.payload,
  );
  commentTemplate(payload, "00000000-0000-0000-0000-000000000000");
  const operation = await acceptOperation({
    kind: "comment",
    scope: user
      ? `user:${user.id}:comment:${number}`
      : `public:comment:${number}`,
    actorId: user?.id,
    key: input.key,
    receiptToken: input.receiptToken,
    payload: { ...payload, issueNumber: number },
    authorize: async () => {
      await requireAnonymousWrite(
        request,
        "comment",
        input.challengeToken,
        input.key,
      );
      await assertEligibleIssue(number, true);
    },
  });
  await launchOperation(operation.id);
  return json(
    { operation: operationView(operation), receiptToken: input.receiptToken },
    202,
  );
});
export const getOperationStatus = route(async (request, context) => {
  const op = await getOperation(uuid.parse(await param(context, "id")));
  if (op.actor_id) {
    const user = await requireUser(request);
    if (user.id !== op.actor_id && user.role !== "admin")
      throw new PipelineError("operation_not_found", 404);
  } else if (op.receipt_digest) {
    const receipt = request.headers.get("X-Receipt-Token") || "";
    if (!sameDigest(sha256(receipt), op.receipt_digest)) {
      const user = await requireAdmin(request, { fresh: false });
      if (!user) throw new PipelineError("operation_not_found", 404);
    }
  } else await requireAdmin(request, { fresh: false });
  return json({ operation: operationView(op) });
});

export const getMapHead = route(async (request) => {
  await requireUser(request);
  const { commit, manifest } = await resolveMapBase();
  return json({ revision: manifest.map_revision, commitSha: commit });
});

export const postEditSession = route(async (request) => {
  enforceSameOrigin(request);
  const user = await requireUser(request);
  const input = z
    .object({
      baseCommit: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^(?:[a-f0-9]{40}|(?:sha256:)?[a-f0-9]{64})$/)
        .optional(),
    })
    .strict()
    .parse(await readJson(request));
  await enforceRateLimits([
    { key: `edit-session:${user.id}`, max: 20, seconds: 3600 },
  ]);
  return json(
    { editSession: await createEditSession(user, input.baseCommit) },
    201,
  );
});
export const getEditSession = route(async (request, context) => {
  const user = await requireUser(request);
  const session = await ownedEditSession(
    uuid.parse(await param(context, "id")),
    user,
  );
  return json({ editSession: await sessionView(session) });
});
export const getSource = route(async (request, context) => {
  const user = await requireUser(request);
  const session = await ownedEditSession(
    uuid.parse(await param(context, "id")),
    user,
  );
  const manifest = parseManifest(
    await readFileAt(session.base_commit, MAP_PATHS.manifest, 64 * 1024),
  );
  const source = await readFileAt(
    session.base_commit,
    MAP_PATHS.json,
    MAP_LIMITS.json,
  );
  if (
    manifest.map_revision !== session.base_revision ||
    sha256(source) !== manifest.files.json.sha256
  )
    throw new PipelineError("manifest_checksum_mismatch");
  return new Response(new Uint8Array(source), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="metro-${session.base_commit.slice(0, 12)}.json"`,
    },
  });
});
export const getPreview = route(async (request, context) => {
  const user = await requireUser(request);
  const session = await ownedEditSession(
    uuid.parse(await param(context, "id")),
    user,
  );
  await enforceRateLimits([
    { key: `preview:${user.id}`, max: 15, seconds: 3600 },
  ]);
  const upload = await query<UploadRecord>(
    `SELECT * FROM metro_uploads WHERE edit_session_id=$1 AND kind='png' AND status='ready' ORDER BY created_at DESC LIMIT 1`,
    [session.id],
  );
  if (!upload.rows[0]) throw new PipelineError("upload_not_found", 404);
  const validated = await validatePng(await readStaged(upload.rows[0]));
  const preview = await sharp(validated.overview)
    .resize({
      width: 1600,
      height: 1600,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 80 })
    .toBuffer();
  if (preview.length > 3 * 1024 * 1024)
    throw new PipelineError("preview_too_large", 413);
  return new Response(new Uint8Array(preview), {
    headers: {
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});
export const postReserveUpload = route(async (request) => {
  enforceSameOrigin(request);
  const user = await requireUser(request);
  const input = z
    .object({ editSessionId: uuid, kind: z.enum(["json", "png"]) })
    .strict()
    .parse(await readJson(request));
  const upload = await reserveUpload(user, input.editSessionId, input.kind);
  return json({ upload: { id: upload.id, pathname: upload.pathname } }, 201);
});
export const postUploadToken = route(async (request) =>
  json(
    await handleStagingUpload(
      request,
      (await readJson(request, 16 * 1024)) as HandleUploadBody,
    ),
  ),
);
export const postCompleteUpload = route(async (request) => {
  enforceSameOrigin(request);
  const user = await requireUser(request);
  const input = z
    .object({ uploadId: uuid })
    .strict()
    .parse(await readJson(request));
  const upload = await completeUpload(input.uploadId, user);
  return json({
    upload: {
      id: upload.id,
      pathname: upload.pathname,
      bytes: Number(upload.size),
      status: upload.status,
    },
  });
});

export const postUpdate = route(async (request) => {
  enforceSameOrigin(request);
  const user = await requireUser(request);
  const input = updateSchema.parse(await readJson(request));
  const idempotencyKey = key(request);
  const scope = `update:${user.id}`;
  const prior = await query<Operation>(
    "SELECT * FROM metro_operations WHERE scope=$1 AND idempotency_key=$2",
    [scope, idempotencyKey],
  );
  let payload: UpdateInput;
  if (prior.rows[0])
    payload = { ...prior.rows[0].payload, ...input } as UpdateInput;
  else {
    const session = await ownedEditSession(input.editSessionId, user, true);
    const uploads = await query<UploadRecord>(
      "SELECT DISTINCT ON(kind) * FROM metro_uploads WHERE edit_session_id=$1 AND owner_id=$2 AND status='ready' ORDER BY kind,created_at DESC",
      [session.id, user.id],
    );
    const jsonUpload = uploads.rows.find((u) => u.kind === "json");
    const pngUpload = uploads.rows.find((u) => u.kind === "png");
    if (!jsonUpload || !pngUpload) throw new PipelineError("uploads_required");
    payload = {
      ...input,
      jsonUploadId: jsonUpload.id,
      pngUploadId: pngUpload.id,
      baseCommit: session.base_commit,
      baseMapRevision: session.base_revision,
    };
  }
  const operation = await acceptOperation({
    kind: "update",
    scope,
    key: idempotencyKey,
    actorId: user.id,
    payload,
    authorize: async () => {
      await enforceRateLimits([
        { key: `update:${user.id}`, max: 5, seconds: 3600 },
      ]);
      await assertFresh(payload.baseMapRevision);
      for (const number of payload.issueNumbers)
        await assertEligibleIssue(number, true);
    },
  });
  await launchOperation(operation.id);
  return json({ operation: operationView(operation) }, 202);
});
export const getUpdates = route(async (request) => {
  const user = await requireUser(request);
  const result = await query<Operation>(
    `SELECT * FROM metro_operations WHERE kind='update' AND ($1::boolean OR actor_id=$2) ORDER BY created_at DESC LIMIT 100`,
    [user.role === "admin", user.id],
  );
  const updates: UpdateSummary[] = result.rows.map((op) => ({
    id: op.id,
    status: op.status,
    summary: String(op.payload.summary),
    createdAt: new Date(op.created_at).toISOString(),
    updatedAt: new Date(op.updated_at).toISOString(),
    baseMapRevision: String(op.payload.baseMapRevision),
    mapRevision:
      typeof op.result.mapRevision === "string"
        ? op.result.mapRevision
        : typeof op.checkpoint.mapRevision === "string"
          ? op.checkpoint.mapRevision
          : null,
    prNumber:
      typeof op.result.prNumber === "number" ? op.result.prNumber : null,
    prUrl: typeof op.result.prUrl === "string" ? op.result.prUrl : null,
    errorCode: op.error_code,
  }));
  const pending =
    user.role === "admin"
      ? []
      : (
          await query<Operation>(
            `SELECT * FROM metro_operations WHERE kind='update' AND status='awaiting_review' AND actor_id<>$1 ORDER BY created_at DESC LIMIT 30`,
            [user.id],
          )
        ).rows;
  const pendingOthers = pending.map((op) => ({
    id: op.id,
    status: op.status,
    summary: String(op.payload.summary),
    createdAt: new Date(op.created_at).toISOString(),
    baseMapRevision: String(op.payload.baseMapRevision),
    mapRevision:
      typeof op.result.mapRevision === "string"
        ? op.result.mapRevision
        : typeof op.checkpoint.mapRevision === "string"
          ? op.checkpoint.mapRevision
          : null,
    prNumber: op.result.prNumber ?? null,
    prUrl: op.result.prUrl ?? null,
  }));
  scheduleReadReconciliation();
  return json({ updates, pendingOthers });
});

export const getAdminOperations = route(async (request) => {
  await requireAdmin(request, { fresh: false });
  const result = await query<Operation>(
    "SELECT * FROM metro_operations ORDER BY created_at DESC LIMIT 100",
  );
  return json({ operations: result.rows.map(operationView) });
});
export const postRetryOperation = route(async (request, context) => {
  enforceSameOrigin(request);
  const user = await requireAdmin(request);
  const operation = await retryOperation(
    uuid.parse(await param(context, "id")),
    user.id,
  );
  await launchOperation(operation.id);
  return json({ operation: operationView(operation) }, 202);
});
export const postSync = route(async (request) => {
  enforceSameOrigin(request);
  const user = await requireAdmin(request);
  const operation = await acceptOperation({
    kind: "sync",
    scope: `sync:${user.id}`,
    key: key(request),
    actorId: user.id,
    payload: { publication: true },
    authorize: async () => {
      await enforceRateLimits([
        { key: `sync:${user.id}`, max: 10, seconds: 3600 },
      ]);
    },
  });
  await launchOperation(operation.id);
  return json({ operation: operationView(operation) }, 202);
});

export const internalRepair = route(async (request) => {
  const secret = process.env.CRON_SECRET;
  if (
    !secret ||
    !sameDigest(
      sha256(request.headers.get("authorization") || ""),
      sha256(`Bearer ${secret}`),
    )
  )
    throw new PipelineError("unauthorized", 401);
  const repaired = await repairOutbox();
  const deletedUploads = await cleanupStaging();
  await pruneSecurityRecords();
  const operation = await acceptOperation({
    kind: "sync",
    scope: "internal:sync",
    key: new Date().toISOString().slice(0, 10),
    payload: { publication: true },
    authorize: async () => undefined,
  });
  await launchOperation(operation.id);
  return json({ repaired, deletedUploads, operationId: operation.id });
});

export const postWebhook = route(async (request) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new PipelineError("service_not_configured", 503);
  const signature = request.headers.get("x-hub-signature-256") || "";
  const delivery = request.headers.get("x-github-delivery") || "";
  const event = request.headers.get("x-github-event") || "";
  if (
    !/^sha256=[a-f0-9]{64}$/.test(signature) ||
    !/^[a-f0-9-]{36}$/i.test(delivery)
  )
    throw new PipelineError("invalid_webhook", 401);
  const reader = request.body?.getReader();
  if (!reader) throw new PipelineError("invalid_webhook", 400);
  const chunks: Buffer[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > 1024 * 1024) {
      await reader.cancel();
      throw new PipelineError("payload_too_large", 413);
    }
    chunks.push(Buffer.from(part.value));
  }
  const bytes = Buffer.concat(chunks);
  if (
    !sameDigest(
      signature,
      `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`,
    )
  )
    throw new PipelineError("invalid_webhook", 401);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new PipelineError("invalid_webhook", 400);
  }
  // GitHub App ping payloads do not necessarily include a repository/installation.
  // Their signature is sufficient for an acknowledgement, and they create no work.
  if (event === "ping") return json({ accepted: true });
  const repo = repositoryConfig();
  const repository = payload.repository as { full_name?: string } | undefined;
  const installation = payload.installation as { id?: number } | undefined;
  const configuredInstallation =
    process.env.GITHUB_INSTALLATION_ID ||
    process.env.GITHUB_APP_INSTALLATION_ID;
  if (
    repository?.full_name?.toLowerCase() !== repo.key.toLowerCase() ||
    (configuredInstallation &&
      String(installation?.id) !== configuredInstallation)
  )
    throw new PipelineError("invalid_webhook_source", 403);
  if (!["push", "pull_request", "issues", "issue_comment"].includes(event))
    return json({ ignored: true });
  if (event === "push" && payload.ref !== `refs/heads/${repo.branch}`)
    return json({ ignored: true });
  const opId = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `delivery:${delivery}`,
    ]);
    const existing = await client.query<{
      payload_digest: string;
      operation_id: string;
    }>("SELECT * FROM metro_webhook_deliveries WHERE id=$1", [delivery]);
    if (existing.rows[0]) {
      if (existing.rows[0].payload_digest !== sha256(bytes))
        throw new PipelineError("webhook_delivery_conflict", 409);
      return existing.rows[0].operation_id;
    }
    const id = randomUUID();
    const operationPayload = {
      publication: event === "push" || event === "pull_request",
      event,
    };
    await client.query(
      `INSERT INTO metro_operations(id,kind,scope,idempotency_key,request_digest,status,payload,checkpoint)
      VALUES($1,'sync','webhook',$2,$3,'accepted',$4,$5)`,
      [
        id,
        delivery,
        sha256(bytes),
        JSON.stringify(operationPayload),
        JSON.stringify({ repository: repo.key, baseBranch: repo.branch }),
      ],
    );
    await client.query(
      "INSERT INTO metro_webhook_deliveries(id,event,payload_digest,operation_id) VALUES($1,$2,$3,$4)",
      [delivery, event, sha256(bytes), id],
    );
    await client.query("INSERT INTO metro_outbox(operation_id) VALUES($1)", [
      id,
    ]);
    return id;
  });
  after(() => launchOperation(opId));
  return json({ accepted: true, operationId: opId }, 202);
});
