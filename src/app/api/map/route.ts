export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Returns the currently published map for public viewing.
// The map page invokes this endpoint.
export { getMap as GET } from "@/server/operations/handlers";
