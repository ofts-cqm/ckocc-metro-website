export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Lists public requests for the request browsing workflow.
// The request list page invokes this endpoint.
export { getIssues as GET } from "@/server/operations/handlers";
