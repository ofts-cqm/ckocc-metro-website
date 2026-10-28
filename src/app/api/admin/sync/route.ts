export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Starts an administrator-triggered synchronization with external state.
// The admin maintenance workflow invokes this endpoint.
export { postSync as POST } from "@/server/operations/handlers";
