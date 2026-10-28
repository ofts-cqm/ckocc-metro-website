export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Accepts a new player request for administrator review.
// The request form invokes this and receives an operation record.
export { postRequest as POST } from "@/server/operations/handlers";
