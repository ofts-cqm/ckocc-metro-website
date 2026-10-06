import { randomUUID } from "node:crypto";
import { get, head, del, put } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import type { SessionUser } from "@/lib/contracts";
import { query, transaction } from "@/server/db";
import { requireUser } from "@/server/auth/authorize";
import { enforceSameOrigin } from "@/server/security";
import { MAP_LIMITS } from "@/server/maps/validate";
import { PipelineError } from "@/server/operations/errors";
import { ownedEditSession } from "@/server/maps/sessions";

export interface UploadRecord {
  id: string;
  edit_session_id: string;
  owner_id: string;
  kind: "json" | "png";
  pathname: string;
  url: string | null;
  size: number | null;
  reserved_bytes: number;
  status: string;
  expires_at: Date;
}
function stagingToken() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new PipelineError("storage_not_configured", 503);
  return token;
}
export async function reserveUpload(
  user: SessionUser,
  editSessionId: string,
  kind: "json" | "png",
) {
  await ownedEditSession(editSessionId, user, true);
  const id = randomUUID();
  const pathname = `staging/${user.id}/${editSessionId}/${id}.${kind}`;
  return transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('staging-quota'))",
    );
    const total = await client.query<{ total: string; own: string }>(
      `SELECT COALESCE(sum(reserved_bytes),0)::text AS total,
      COALESCE(sum(reserved_bytes) FILTER(WHERE owner_id=$1),0)::text AS own FROM metro_uploads WHERE status<>'deleted'`,
      [user.id],
    );
    if (
      Number(total.rows[0].own) + MAP_LIMITS[kind] > 128 * 1024 * 1024 ||
      Number(total.rows[0].total) + MAP_LIMITS[kind] > 1024 * 1024 * 1024
    )
      throw new PipelineError("storage_quota_exceeded", 429);
    const result = await client.query<UploadRecord>(
      `INSERT INTO metro_uploads(id,edit_session_id,owner_id,kind,pathname,reserved_bytes,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days') RETURNING *`,
      [id, editSessionId, user.id, kind, pathname, MAP_LIMITS[kind]],
    );
    return result.rows[0];
  });
}

export async function uploadRecord(id: string) {
  const result = await query<UploadRecord>(
    "SELECT * FROM metro_uploads WHERE id=$1",
    [id],
  );
  if (!result.rows[0] || result.rows[0].status === "deleted")
    throw new PipelineError("upload_not_found", 404);
  return result.rows[0];
}

export async function completeUpload(id: string, user?: SessionUser) {
  const upload = await uploadRecord(id);
  if (user) {
    if (upload.owner_id !== user.id)
      throw new PipelineError("upload_not_found", 404);
    await ownedEditSession(upload.edit_session_id, user, true);
  }
  if (new Date(upload.expires_at).getTime() < Date.now())
    throw new PipelineError("upload_expired", 409);
  // Do not trust browser URLs or byte counts, including the Blob completion payload.
  const metadata = await head(upload.pathname, { token: stagingToken() });
  if (
    metadata.pathname !== upload.pathname ||
    metadata.size < 1 ||
    metadata.size > MAP_LIMITS[upload.kind] ||
    metadata.contentType !==
      (upload.kind === "png" ? "image/png" : "application/json")
  )
    throw new PipelineError("invalid_upload");
  const result = await query<UploadRecord>(
    `UPDATE metro_uploads SET url=$2,size=$3,status='ready' WHERE id=$1 AND status IN ('reserved','ready') RETURNING *`,
    [id, metadata.url, metadata.size],
  );
  return result.rows[0] ?? upload;
}

export async function handleStagingUpload(
  request: Request,
  body: HandleUploadBody,
) {
  return handleUpload({
    request,
    body,
    token: stagingToken(),
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      enforceSameOrigin(request);
      const user = await requireUser(request);
      let uploadId: string;
      try {
        uploadId = JSON.parse(clientPayload || "{}").uploadId;
      } catch {
        throw new PipelineError("invalid_upload");
      }
      if (typeof uploadId !== "string" || !/^[a-f0-9-]{36}$/.test(uploadId))
        throw new PipelineError("invalid_upload");
      const upload = await uploadRecord(uploadId);
      if (
        upload.owner_id !== user.id ||
        upload.pathname !== pathname ||
        upload.status !== "reserved"
      )
        throw new PipelineError("invalid_upload");
      await ownedEditSession(upload.edit_session_id, user, true);
      return {
        allowedContentTypes: [
          upload.kind === "png" ? "image/png" : "application/json",
        ],
        maximumSizeInBytes: MAP_LIMITS[upload.kind],
        addRandomSuffix: false,
        allowOverwrite: false,
        validUntil: Date.now() + 15 * 60 * 1000,
        tokenPayload: JSON.stringify({ uploadId: upload.id }),
      };
    },
    // handleUpload validates the provider signature before invoking this callback.
    onUploadCompleted: async ({ tokenPayload }) => {
      const { uploadId } = JSON.parse(tokenPayload || "{}") as {
        uploadId: string;
      };
      if (typeof uploadId !== "string" || !/^[a-f0-9-]{36}$/.test(uploadId))
        throw new PipelineError("invalid_upload");
      await completeUpload(uploadId);
    },
  });
}

export async function readStaged(upload: UploadRecord): Promise<Buffer> {
  const result = await get(upload.pathname, {
    access: "private",
    token: stagingToken(),
  });
  if (!result || result.statusCode !== 200 || !result.stream)
    throw new PipelineError("upload_not_found", 404);
  const reader = result.stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAP_LIMITS[upload.kind]) {
      await reader.cancel();
      throw new PipelineError("file_too_large", 413);
    }
    chunks.push(Buffer.from(next.value));
  }
  if (size < 1 || (upload.size !== null && size !== Number(upload.size)))
    throw new PipelineError("invalid_upload");
  return Buffer.concat(chunks);
}

export async function cleanupStaging() {
  // Keep every asset referenced by queued/unknown/failed operations for operator recovery.
  const expired =
    await query<UploadRecord>(`SELECT u.* FROM metro_uploads u WHERE u.status<>'deleted' AND
    (u.expires_at<now() OR EXISTS(SELECT 1 FROM metro_operations o WHERE o.kind='update' AND o.status IN ('awaiting_review','merged','published','closed_unmerged') AND o.payload->>'editSessionId'=u.edit_session_id::text))
    AND NOT EXISTS(SELECT 1 FROM metro_operations o WHERE o.kind='update' AND o.status IN ('accepted','validating','creating_pr','failed','outcome_unknown') AND o.payload->>'editSessionId'=u.edit_session_id::text)
    ORDER BY u.created_at LIMIT 50`);
  let deleted = 0;
  for (const upload of expired.rows) {
    await del(upload.pathname, { token: stagingToken() });
    await query(
      "UPDATE metro_uploads SET status='deleted',url=NULL WHERE id=$1",
      [upload.id],
    );
    deleted++;
  }
  return deleted;
}

export async function publishImage(
  revision: string,
  png: Buffer,
  overview: Buffer,
) {
  const token = process.env.PUBLISHED_BLOB_READ_WRITE_TOKEN;
  if (!token || token === process.env.BLOB_READ_WRITE_TOKEN)
    throw new PipelineError("storage_not_configured", 503);
  const prefix = `maps/${revision.replace("sha256:", "")}`;
  async function immutable(path: string, data: Buffer) {
    // A revision path always has identical validated content; reuse after workflow interruption.
    try {
      return await head(path, { token });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "BlobNotFoundError")
        throw error;
      return put(path, data, {
        token,
        access: "public",
        contentType: "image/png",
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: 31_536_000,
      });
    }
  }
  const original = await immutable(`${prefix}/network.png`, png);
  const reduced = await immutable(`${prefix}/overview.png`, overview);
  return { imageUrl: original.url, overviewUrl: reduced.url };
}
