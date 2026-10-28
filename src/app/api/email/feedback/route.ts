export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Receives provider delivery feedback for outbound email jobs.
// The email workflow uses it to record delivery, bounce, or complaint results.
export { postEmailFeedback as POST } from "@/server/email/feedback";
