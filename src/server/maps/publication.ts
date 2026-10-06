import type { PublishedMap } from "@/lib/contracts";
import { getPool, query } from "@/server/db";
import {
  github,
  repositoryConfig,
  currentHead,
  readFileAt,
  MAP_PATHS,
} from "@/server/github/client";
import { MAP_LIMITS, parseManifest, validatePair } from "./validate";
import { publishImage } from "@/server/storage/staging";
import { PipelineError } from "@/server/operations/errors";

type Publication = {
  commit_sha: string;
  revision: string;
  image_url: string;
  overview_url: string;
  published_at: Date;
  width: number;
  height: number;
  manifest: { summary: string };
};
export async function publishedMap(): Promise<PublishedMap | null> {
  const result = await query<Publication>(
    "SELECT * FROM metro_publications WHERE repository=$1",
    [repositoryConfig().key],
  );
  const row = result.rows[0];
  return row
    ? {
        revision: row.revision,
        commitSha: row.commit_sha,
        imageUrl: row.image_url,
        overviewUrl: row.overview_url,
        publishedAt: new Date(row.published_at).toISOString(),
        width: row.width,
        height: row.height,
        summary: row.manifest.summary,
      }
    : null;
}

/** Always reconcile HEAD, never the (possibly old) webhook's commit. */
export async function synchronizePublication() {
  const { key } = repositoryConfig();
  const lock = await getPool().connect();
  try {
    await lock.query("BEGIN");
    const taken = await lock.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
      [`publication:${key}`],
    );
    if (!taken.rows[0].locked) throw new PipelineError("publication_busy", 503);
    const commit = await currentHead();
    const manifest = parseManifest(
      await readFileAt(commit, MAP_PATHS.manifest, 64 * 1024),
    );
    const previous = await lock.query<Publication>(
      "SELECT * FROM metro_publications WHERE repository=$1",
      [key],
    );
    if (previous.rows[0]?.commit_sha === commit) {
      await lock.query(
        `UPDATE metro_operations SET status='published',result=result||jsonb_build_object('publishedAt',now(),'publicationPending',false),updated_at=now()
        WHERE kind='update' AND checkpoint->>'mapRevision'=$1 AND status='merged'`,
        [manifest.map_revision],
      );
      await lock.query("COMMIT");
      return { revision: manifest.map_revision, commitSha: commit };
    }
    const [json, png] = await Promise.all([
      readFileAt(commit, MAP_PATHS.json, MAP_LIMITS.json),
      readFileAt(commit, MAP_PATHS.png, MAP_LIMITS.png),
    ]);
    const pair = await validatePair(json, png, manifest);
    const images = await publishImage(pair.revision, png, pair.image.overview);
    // No pointer change until full validation, public delivery, and the latest-head recheck succeed.
    if ((await currentHead()) !== commit)
      throw new PipelineError("publication_outdated", 503);
    await lock.query(
      `INSERT INTO metro_publications(repository,commit_sha,revision,manifest,json_sha,png_sha,image_url,overview_url,width,height)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(repository) DO UPDATE SET commit_sha=$2,revision=$3,manifest=$4,
      json_sha=$5,png_sha=$6,image_url=$7,overview_url=$8,width=$9,height=$10,published_at=now()`,
      [
        key,
        commit,
        pair.revision,
        JSON.stringify(manifest),
        pair.jsonHash,
        pair.pngHash,
        images.imageUrl,
        images.overviewUrl,
        pair.image.width,
        pair.image.height,
      ],
    );
    await lock.query(
      `UPDATE metro_operations SET status='published',result=result||jsonb_build_object('publishedAt',now(),'publicationPending',false),updated_at=now()
      WHERE kind='update' AND checkpoint->>'mapRevision'=$1 AND status='merged'`,
      [pair.revision],
    );
    await lock.query("COMMIT");
    return { revision: pair.revision, commitSha: commit };
  } catch (error) {
    await lock.query("ROLLBACK");
    throw error;
  } finally {
    lock.release();
  }
}

export async function synchronizePullRequests() {
  const client = await github();
  const { owner, repo } = repositoryConfig();
  const ops = await query<{
    id: string;
    result: { prNumber: number };
    status: string;
  }>(`SELECT id,result,status FROM metro_operations
    WHERE kind='update' AND status IN ('awaiting_review','merged') AND result ? 'prNumber' ORDER BY updated_at LIMIT 50`);
  for (const op of ops.rows) {
    const pr = (
      await client.rest.pulls.get({
        owner,
        repo,
        pull_number: op.result.prNumber,
      })
    ).data;
    if (pr.merged || pr.state === "closed")
      await query(
        `UPDATE metro_operations SET status=$2,
      result=result||$3::jsonb,updated_at=now() WHERE id=$1 AND status IN ('awaiting_review','merged')`,
        [
          op.id,
          pr.merged ? "merged" : "closed_unmerged",
          JSON.stringify({
            mergedAt: pr.merged_at,
            publicationPending: !!pr.merged,
          }),
        ],
      );
  }
}
