export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Returns the state of an existing map editing session.
// The editor invokes this when resuming or refreshing a draft.
export { getEditSession as GET } from "@/server/operations/handlers";
