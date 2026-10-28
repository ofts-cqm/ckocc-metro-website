export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Lists chronological comments for a request discussion.
// The request detail page invokes this when loading conversation history.
export { getComments as GET } from "@/server/operations/handlers";
// Submits a comment to a request discussion.
// The request detail page invokes this from its comment composer.
export { postComment as POST } from "@/server/operations/handlers";
