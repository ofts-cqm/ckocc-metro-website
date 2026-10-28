export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Returns an operation status to its submitting client.
// Submission and maintenance pages poll this while durable work progresses.
export { getOperationStatus as GET } from "@/server/operations/handlers";
