export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Finalizes an upload after the client sends its reserved bytes.
// The map submission workflow invokes this before using uploaded files.
export { postCompleteUpload as POST } from "@/server/operations/handlers";
