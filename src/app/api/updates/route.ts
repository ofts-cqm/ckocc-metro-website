export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export {
  getUpdates as GET,
  postUpdate as POST,
} from "@/server/operations/handlers";
