import "server-only";

/** Reads the email delivery feature switch.
 * Job dispatch and execution use it before sending.
 */
export function emailEnabled() {
  return process.env.EMAIL_NOTIFICATIONS_ENABLED === "true";
}

/** Validates SES region, sender, and site origin settings.
 * The email worker calls it before composing a send.
 */
export function emailConfig() {
  const region = process.env.AWS_REGION;
  const from = process.env.SES_FROM_EMAIL;
  const origin = process.env.APP_URL || process.env.BETTER_AUTH_URL;
  if (!region || !from || !origin) throw new Error("email_not_configured");
  const url = new URL(origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("email_invalid_origin");
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new Error("email_https_required");
  return {
    region,
    from,
    origin: url.origin,
    replyTo: process.env.SES_REPLY_TO_EMAIL,
  };
}
