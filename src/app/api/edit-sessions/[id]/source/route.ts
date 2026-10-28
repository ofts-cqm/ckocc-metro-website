export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Returns source material for a map editing session.
// The editor invokes this when loading the draft and its base map.
export { getSource as GET } from "@/server/operations/handlers";
