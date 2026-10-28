export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Returns the current preview for a map editing session.
// The editor invokes this while the user reviews a proposed map change.
export { getPreview as GET } from "@/server/operations/handlers";
