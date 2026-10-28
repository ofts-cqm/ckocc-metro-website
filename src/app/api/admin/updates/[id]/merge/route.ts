export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Submits an approved map update for merging from the admin review workflow.
// The server handler checks branch and review state before external writes.
export { postMerge as POST } from "@/server/operations/map-action-handlers";
