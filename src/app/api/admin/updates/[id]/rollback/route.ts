export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Starts rollback of a previously merged update from admin review.
// The server handler records and reconciles the maintenance operation.
export { postRollback as POST } from "@/server/operations/map-action-handlers";
