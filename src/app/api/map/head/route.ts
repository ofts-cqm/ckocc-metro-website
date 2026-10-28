export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Returns the published map head used to detect a changed edit base.
// The map editor invokes this before or during an update submission.
export { getMapHead as GET } from "@/server/operations/handlers";
