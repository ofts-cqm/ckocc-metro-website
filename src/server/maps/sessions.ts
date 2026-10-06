import { randomUUID } from "node:crypto";
import type { EditSession, SessionUser } from "@/lib/contracts";
import { query } from "@/server/db";
import {
  github,
  repositoryConfig,
  currentHead,
  readFileAt,
  MAP_PATHS,
} from "@/server/github/client";
import { parseManifest } from "./validate";
import { PipelineError } from "@/server/operations/errors";
import type { UploadRecord } from "@/server/storage/staging";

export interface EditSessionRecord {
  id: string;
  owner_id: string;
  base_commit: string;
  base_revision: string;
  expires_at: Date;
  created_at: Date;
  status: string;
}
export async function headManifest() {
  const commit = await currentHead();
  const manifest = parseManifest(
    await readFileAt(commit, MAP_PATHS.manifest, 64 * 1024),
  );
  return { commit, manifest };
}

export async function createEditSession(
  user: SessionUser,
  knownBaseCommit?: string,
) {
  // A supplied known commit is checked through GitHub; never adopt the latest for an unknown export.
  if (knownBaseCommit) {
    const client = await github();
    const { owner, repo } = repositoryConfig();
    const current = await currentHead();
    const comparison = await client.rest.repos.compareCommits({
      owner,
      repo,
      base: knownBaseCommit,
      head: current,
    });
    if (!["ahead", "identical"].includes(comparison.data.status))
      throw new PipelineError("unapproved_base_revision", 409);
  }
  const base = knownBaseCommit
    ? {
        commit: knownBaseCommit,
        manifest: parseManifest(
          await readFileAt(knownBaseCommit, MAP_PATHS.manifest, 64 * 1024),
        ),
      }
    : await headManifest();
  const result = await query<EditSessionRecord>(
    `INSERT INTO metro_edit_sessions(id,owner_id,base_commit,base_revision,expires_at)
    VALUES($1,$2,$3,$4,now()+interval '7 days') RETURNING *`,
    [randomUUID(), user.id, base.commit, base.manifest.map_revision],
  );
  return sessionView(result.rows[0]);
}
export async function ownedEditSession(
  id: string,
  user: SessionUser,
  writable = false,
) {
  const result = await query<EditSessionRecord>(
    "SELECT * FROM metro_edit_sessions WHERE id=$1",
    [id],
  );
  const session = result.rows[0];
  if (!session || (session.owner_id !== user.id && user.role !== "admin"))
    throw new PipelineError("edit_session_not_found", 404);
  if (
    writable &&
    (session.owner_id !== user.id ||
      session.status !== "draft" ||
      new Date(session.expires_at).getTime() < Date.now())
  )
    throw new PipelineError("edit_session_expired", 409);
  return session;
}
export async function sessionView(
  session: EditSessionRecord,
): Promise<EditSession> {
  const uploads = await query<UploadRecord>(
    "SELECT * FROM metro_uploads WHERE edit_session_id=$1 AND status='ready' ORDER BY created_at",
    [session.id],
  );
  const assets: NonNullable<EditSession["assets"]> = {};
  for (const upload of uploads.rows)
    assets[upload.kind] = {
      pathname: upload.pathname,
      bytes: Number(upload.size),
    };
  return {
    id: session.id,
    baseCommit: session.base_commit,
    baseMapRevision: session.base_revision,
    createdAt: new Date(session.created_at).toISOString(),
    expiresAt: new Date(session.expires_at).toISOString(),
    status: session.status,
    sourceUrl: `/api/edit-sessions/${session.id}/source`,
    assets,
  };
}

export async function assertFresh(baseRevision: string) {
  const head = await headManifest();
  if (head.manifest.map_revision !== baseRevision)
    throw new PipelineError("stale_base_revision", 409);
  return head;
}
