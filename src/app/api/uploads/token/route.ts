export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Issues a short-lived token for a reserved upload.
// The map editor invokes this before sending file bytes.
export { postUploadToken as POST } from "@/server/operations/handlers";
