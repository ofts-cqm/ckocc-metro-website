"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { subscriberMessages } from "@/lib/subscriber-messages";
import {
  api,
  ErrorNotice,
  Field,
  Loading,
  localeHref,
  Notice,
  PageIntro,
  useApi,
  useAuth,
  useLocale,
  useMessages,
} from "./ui";

type Preferences = {
  email: string;
  verified: boolean;
  enabled: boolean;
  mapUpdates: boolean;
  locale: string;
  pendingAddress: string | null;
  suppressed: boolean;
};
export function EmailSettingsPage() {
  const m = useMessages();
  const locale = useLocale();
  const auth = useAuth();
  const subscription = subscriberMessages(locale);
  const settings = useApi<{ preferences: Preferences }>(
    auth.user ? "/api/email/preferences" : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const [mapDraft, setMapDraft] = useState<boolean | null>(null);
  useEffect(() => {
    setEnabledDraft(null);
    setMapDraft(null);
  }, [settings.data]);
  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      await action();
      setMessage(success);
      setPassword("");
      settings.refresh();
      return true;
    } catch (error) {
      setError(error);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const value = settings.data?.preferences;
  const subscriber = auth.user?.role === "subscriber";
  const verificationRequired = subscriber && !value?.verified;
  function changeAddress(event: FormEvent) {
    event.preventDefault();
    void perform(
      () =>
        api("/api/email/verification", {
          method: "POST",
          body: JSON.stringify({ locale, address, password }),
        }),
      m.emailVerificationQueued,
    );
  }
  return (
    <div className="container invitation-page">
      <PageIntro
        eyebrow={m.loginEyebrow}
        title={m.emailSettings}
        description={m.emailSettingsIntro}
      />
      {auth.loading || (settings.loading && !settings.data) ? (
        <Loading />
      ) : !auth.user ? (
        <Notice>
          <Link href={localeHref(locale, "/login?next=settings")}>
            {m.signIn}
          </Link>
        </Notice>
      ) : value ? (
        <div className="form-panel">
          <p>
            <strong>{m.email}:</strong> {value.email}
          </p>
          <p>{value.verified ? m.emailVerified : m.emailUnverified}</p>
          {value.suppressed && (
            <Notice tone="error">{m.emailSuppressed}</Notice>
          )}
          {value.pendingAddress && (
            <Notice>
              {m.emailPending.replace("{address}", value.pendingAddress)}
            </Notice>
          )}
          <fieldset disabled={busy}>
            {!value.verified && (
              <button
                className="button button-secondary"
                type="button"
                onClick={() =>
                  void perform(
                    () =>
                      api("/api/email/verification", {
                        method: "POST",
                        body: JSON.stringify({ locale }),
                      }),
                    m.emailVerificationQueued,
                  )
                }
              >
                {m.emailSendVerification}
              </button>
            )}
            {verificationRequired && (
              <Notice>{subscription.verificationRequired}</Notice>
            )}
            <Field
              label={subscription.mapEmails}
              hint={subscription.mapEmailHint}
            >
              <label>
                <input
                  type="checkbox"
                  disabled={verificationRequired}
                  checked={mapDraft ?? value.mapUpdates ?? false}
                  onChange={async (event) => {
                    const mapUpdates = event.target.checked;
                    setMapDraft(mapUpdates);
                    const saved = await perform(
                      () =>
                        api("/api/email/preferences", {
                          method: "POST",
                          body: JSON.stringify({
                            enabled: subscriber ? false : value.enabled,
                            mapUpdates,
                            locale,
                          }),
                        }),
                      m.emailPreferencesSaved,
                    );
                    if (!saved) setMapDraft(null);
                  }}
                />{" "}
                {subscription.mapEmails}
              </label>
            </Field>
            <p>{subscription.quotaHint}</p>
            {!subscriber && (
              <Field
                label={subscription.discussionEmails}
                hint={m.emailNotificationsHint}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={enabledDraft ?? value.enabled}
                    onChange={async (event) => {
                      const enabled = event.target.checked;
                      setEnabledDraft(enabled);
                      const saved = await perform(
                        () =>
                          api("/api/email/preferences", {
                            method: "POST",
                            body: JSON.stringify({ enabled, locale }),
                          }),
                        m.emailPreferencesSaved,
                      );
                      if (!saved) setEnabledDraft(null);
                    }}
                  />{" "}
                  {m.emailOptIn}
                </label>
              </Field>
            )}
          </fieldset>
          <form onSubmit={changeAddress}>
            <h2>{m.emailChange}</h2>
            <p>{m.emailChangeHint}</p>
            <fieldset disabled={busy || verificationRequired}>
              <Field label={m.emailNewAddress}>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                />
              </Field>
              <Field label={m.password}>
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <button className="button button-primary" type="submit">
                {busy ? m.submitting : m.emailChange}
              </button>
            </fieldset>
          </form>
          <ErrorNotice error={error} />
          {message && <Notice>{message}</Notice>}
        </div>
      ) : (
        <ErrorNotice error={settings.error} />
      )}
    </div>
  );
}

export function EmailConfirmationPage({
  unsubscribe = false,
}: {
  unsubscribe?: boolean;
}) {
  const m = useMessages();
  const locale = useLocale();
  const auth = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const capturedToken = useRef(false);
  useEffect(() => {
    if (capturedToken.current) return;
    capturedToken.current = true;
    setToken(
      new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "",
    );
    // Fragments never reach HTTP access logs. Remove the secret from browser history too.
    window.history.replaceState({}, "", window.location.pathname);
  }, []);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function confirm(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ changed: boolean }>(
        `/api/email/${unsubscribe ? "unsubscribe" : "verify"}`,
        { method: "POST", body: JSON.stringify({ token }) },
      );
      setChanged(result.changed);
      setDone(true);
      auth.refresh();
      window.history.replaceState(
        {},
        "",
        `/${locale}/email/${unsubscribe ? "unsubscribe" : "verify"}`,
      );
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="container invitation-page">
      <PageIntro
        eyebrow={m.loginEyebrow}
        title={unsubscribe ? m.emailUnsubscribe : m.emailConfirm}
        description={
          unsubscribe ? m.emailUnsubscribeIntro : m.emailConfirmIntro
        }
      />
      <div className="form-panel">
        {done ? (
          <>
            <Notice>
              {unsubscribe
                ? m.emailUnsubscribed
                : changed
                  ? m.emailChanged
                  : m.emailConfirmed}
            </Notice>
            <Link
              className="button button-primary"
              href={localeHref(locale, changed ? "/login" : "/settings")}
            >
              {changed ? m.signIn : m.emailSettings}
            </Link>
          </>
        ) : (
          <form onSubmit={confirm}>
            {token === null ? (
              <Loading />
            ) : !token ? (
              <Notice tone="error">{m.emailInvalidLink}</Notice>
            ) : (
              <button
                className="button button-primary"
                type="submit"
                disabled={busy}
              >
                {busy
                  ? m.submitting
                  : unsubscribe
                    ? m.emailUnsubscribe
                    : m.emailConfirm}
              </button>
            )}
            <ErrorNotice error={error} />
          </form>
        )}
      </div>
    </div>
  );
}
