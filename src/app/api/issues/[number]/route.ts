export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Loads one request and its current discussion metadata.
// The request detail page invokes this endpoint.
export { getIssue as GET } from "@/server/operations/handlers";
