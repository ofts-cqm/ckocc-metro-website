import { requireAdmin } from "@/server/auth/authorize";
import { query } from "@/server/db";
import { errorResponse, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Summarizes recent email jobs and provider feedback for administrators.
// The admin email dashboard invokes this to inspect delivery state.
export async function GET(request: Request) {
  try {
    await requireAdmin(request, { fresh: false });
    const jobs =
      await query(`SELECT j.id, j.operation_id AS "operationId", j.kind,
      j.status, j.attempts, j.error_code AS "errorCode", j.ses_message_id AS "sesMessageId",
      j.updated_at AS "updatedAt",
      COALESCE((SELECT jsonb_agg(DISTINCT f.event_kind) FROM metro_email_feedback f
        WHERE f.ses_message_id=j.ses_message_id), '[]'::jsonb) AS feedback
      FROM metro_email_jobs j ORDER BY j.updated_at DESC LIMIT 100`);
    const feedback =
      await query(`SELECT event_kind AS kind, count(*)::integer AS count,
      max(processed_at) AS "lastReceivedAt" FROM metro_email_feedback GROUP BY event_kind`);
    return json({ jobs: jobs.rows, feedback: feedback.rows });
  } catch (error) {
    return errorResponse(error);
  }
}
