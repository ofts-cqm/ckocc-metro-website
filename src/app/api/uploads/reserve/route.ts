export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Reserves an upload in the map submission workflow.
// The handler records size, ownership, and expected file information.
export { postReserveUpload as POST } from "@/server/operations/handlers";
