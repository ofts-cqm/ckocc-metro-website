export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Runs repair for pending operations and email jobs through GET.
// Scheduled maintenance invokes this to resume durable work.
export { internalRepair as GET } from "@/server/operations/handlers";
// Runs the same repair pass through POST for compatible schedulers.
// Internal maintenance invokes this with its cron credential.
export { internalRepair as POST } from "@/server/operations/handlers";
