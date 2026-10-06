export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export {
  internalRepair as GET,
  internalRepair as POST,
} from "@/server/operations/handlers";
