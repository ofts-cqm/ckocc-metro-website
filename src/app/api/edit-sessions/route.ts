export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Creates a map editing session for the map update workflow.
// The server handler records the edit base and authorization.
export { postEditSession as POST } from "@/server/operations/handlers";
