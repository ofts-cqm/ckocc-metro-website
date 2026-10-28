export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Lists line updates for the update browsing workflow.
// The update pages invoke this when loading update history.
export { getUpdates as GET } from "@/server/operations/handlers";
// Accepts a submitted line update for administrator review.
// The update form invokes this and receives a tracked operation.
export { postUpdate as POST } from "@/server/operations/handlers";
