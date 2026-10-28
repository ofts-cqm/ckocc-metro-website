export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Loads the pull request and operation details for admin map review.
// The review page invokes this before offering merge, close, or rollback actions.
export { getReview as GET } from "@/server/operations/map-action-handlers";
