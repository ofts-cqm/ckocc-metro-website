export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Closes a request in the issue discussion workflow.
// The handler applies authorization and records the external operation.
export { postCloseIssue as POST } from "@/server/operations/handlers";
