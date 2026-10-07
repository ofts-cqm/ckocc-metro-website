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
import {
  PipelineError,
  statusOf,
  safeErrorCode,
} from "@/server/operations/errors";
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

/** Resolve only approved default-branch history, pinned to one HEAD snapshot.
 * A revert can restore an older revision, so prefer HEAD over submission dates.
 */
export async function resolveMapBase(knownBase?: string) {
  const value = knownBase?.trim().toLowerCase();
  if (value && !/^(?:[a-f0-9]{40}|(?:sha256:)?[a-f0-9]{64})$/.test(value))
    throw new PipelineError("invalid_base_format");
  try {
    const current = await headManifest();
    if (!value) return current;
    const client = await github();
    const { owner, repo } = repositoryConfig();
    if (/^[a-f0-9]{40}$/.test(value)) {
      // Git commit support retained for previously downloaded sources.
      let comparison;
      try {
        comparison = await client.rest.repos.compareCommits({
          owner,
          repo,
          base: value,
          head: current.commit,
        });
      } catch (error) {
        if (statusOf(error) === 404)
          throw new PipelineError("base_revision_not_found", 404);
        throw error;
      }
      if (!["ahead", "identical"].includes(comparison.data.status))
        throw new PipelineError("unapproved_base_revision", 409);
      try {
        return {
          commit: value,
          manifest: parseManifest(
            await readFileAt(value, MAP_PATHS.manifest, 64 * 1024),
          ),
        };
      } catch (error) {
        if (statusOf(error) === 404)
          throw new PipelineError("base_revision_not_found", 404);
        throw error;
      }
    }
    const revision = value.startsWith("sha256:") ? value : `sha256:${value}`;
    if (current.manifest.map_revision === revision) return current;
    // Search actual approved history, including squash merges and reverts.
    // File hashes and unmerged PRs are deliberately not accepted as map versions.
    for (let page = 1; ; page++) {
      const commits = await client.rest.repos.listCommits({
        owner,
        repo,
        sha: current.commit,
        path: MAP_PATHS.manifest,
        per_page: 100,
        page,
      });
      for (const commit of commits.data) {
        if (commit.sha === current.commit) continue;
        let bytes;
        try {
          bytes = await readFileAt(commit.sha, MAP_PATHS.manifest, 64 * 1024);
        } catch (error) {
          // The history may include removal of the map before it was restored.
          if (statusOf(error) === 404) continue;
          throw error;
        }
        const manifest = parseManifest(bytes);
        if (manifest.map_revision === revision)
          return { commit: commit.sha, manifest };
      }
      if (commits.data.length < 100) break;
    }
    throw new PipelineError("base_revision_not_found", 404);
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    // Do not let provider errors become HTTP 500 or leak provider details.
    throw new PipelineError(safeErrorCode(error), 503);
  }
}

export async function createEditSession(
  user: SessionUser,
  knownBaseCommit?: string,
) {
  const base = await resolveMapBase(knownBaseCommit);
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
