export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Lists operation state for administrator review and recovery.
// The operations dashboard invokes this when inspecting queued or failed work.
export { getAdminOperations as GET } from "@/server/operations/handlers";
