"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Mail, ArrowRight } from "lucide-react";
import { subscriberMessages } from "@/lib/subscriber-messages";
import {
  api,
  ApiError,
  ErrorNotice,
  Field,
  localeHref,
  Notice,
  PageIntro,
  useAuth,
  useLocale,
  useMessages,
} from "./ui";
import { Turnstile } from "./turnstile";

export function SubscribeCallout() {
  const locale = useLocale();
  const { user } = useAuth();
  const sm = subscriberMessages(locale);
  return (
    <aside className="subscription-callout">
      <div className="subscription-callout-copy">
        <h2>{sm.calloutTitle}</h2>
        <p>{sm.calloutBody}</p>
      </div>
      <Link
        className="button button-primary"
        href={localeHref(locale, user ? "/settings" : "/subscribe")}
      >
        <Mail size={18} aria-hidden="true" />
        {sm.subscribe}
        <ArrowRight size={16} aria-hidden="true" />
      </Link>
    </aside>
  );
}

export function SubscriptionPage() {
  const locale = useLocale();
  const m = useMessages();
  const sm = subscriberMessages(locale);
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [challenge, setChallenge] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errorMessage =
    error instanceof ApiError
      ? (
          {
            subscription_email_taken: sm.emailTaken,
            name_conflict: sm.nameTaken,
            subscription_invitation_pending: sm.invitationPending,
            subscription_delivery_pending: sm.deliveryPending,
            subscription_delivery_failed: sm.deliveryFailed,
            subscription_delivery_unknown: sm.deliveryUnknown,
            NETWORK_ERROR: sm.deliveryUnknown,
            internal_error: sm.deliveryUnknown,
          } as Record<string, string>
        )[error.code]
      : undefined;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!challenge || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ delivery?: string }>("/api/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          email,
          displayName: name,
          locale:
            locale === "zh-cn"
              ? "zh-CN"
              : locale === "zh-hk"
                ? "zh-HK"
                : "en-US",
          challenge,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (result.delivery !== "sent")
        throw new ApiError("subscription_delivery_unknown");
      setSent(true);
    } catch (e) {
      setError(e);
      setAttempt((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="container invitation-page">
      <PageIntro
        eyebrow={m.loginEyebrow}
        title={sm.subscribe}
        description={sm.intro}
      />
      <div className="form-panel">
        {user ? (
          <Link
            className="button button-primary"
            href={localeHref(locale, "/settings")}
          >
            {m.emailSettings}
          </Link>
        ) : sent ? (
          <Notice tone="success">{sm.sent}</Notice>
        ) : (
          <form onSubmit={submit}>
            <fieldset disabled={busy}>
              <Field label={m.email}>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label={m.gameName} hint={m.gameNameHint}>
                <input
                  required
                  maxLength={64}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <label className="checkbox-field">
                <input type="checkbox" required /> <span>{sm.consent}</span>
              </label>
              <p className="field-hint">{sm.quotaHint}</p>
              <Turnstile key={attempt} onVerify={setChallenge} />
              {errorMessage ? (
                <Notice tone="error">
                  {errorMessage}
                  {error instanceof ApiError &&
                    error.code === "subscription_email_taken" && (
                      <>
                        {" "}
                        <Link href={localeHref(locale, "/login?next=settings")}>
                          {m.signIn}
                        </Link>
                      </>
                    )}
                </Notice>
              ) : (
                <ErrorNotice error={error} />
              )}
              <button
                className="button button-primary full-width"
                disabled={busy || !challenge}
              >
                {busy ? m.submitting : sm.subscribe}
              </button>
            </fieldset>
          </form>
        )}
      </div>
    </div>
  );
}
