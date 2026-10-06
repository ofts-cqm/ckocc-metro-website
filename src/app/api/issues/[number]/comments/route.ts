export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export {
  getComments as GET,
  postComment as POST,
} from "@/server/operations/handlers";
