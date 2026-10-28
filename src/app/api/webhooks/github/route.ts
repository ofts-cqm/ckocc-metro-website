export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Receives GitHub webhook events for map and request operations.
// The handler reconciles external pull request and issue changes.
export { postWebhook as POST } from "@/server/operations/handlers";
