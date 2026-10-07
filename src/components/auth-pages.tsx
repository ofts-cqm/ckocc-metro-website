"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from "@/lib/password-policy";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  KeyRound,
  LockKeyhole,
  TrainFront,
} from "lucide-react";
import {
  api,
  ApiError,
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

export function LoginPage() {
  const m = useMessages();
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setPassword("");
      auth.refresh();
      const next = params.get("next");
      const destination =
        next === "admin"
          ? localeHref(locale, "/admin")
          : next &&
              /^\/(en-us|zh-cn|zh-hk)\/(updates|admin)(?:\?.*)?$/.test(next)
            ? next.replace(/^\/(en-us|zh-cn|zh-hk)/, `/${locale}`)
            : localeHref(locale, "/updates");
      router.push(destination);
      router.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="container auth-page">
      <Link className="back-link" href={localeHref(locale)}>
        <ArrowLeft size={15} />
        {m.home}
      </Link>
      <div className="auth-layout">
        <div className="auth-story">
          <span className="auth-symbol">
            <TrainFront size={39} />
          </span>
          <PageIntro
            eyebrow={m.loginEyebrow}
            title={m.loginTitle}
            description={m.loginIntro}
          />
          <div className="auth-rail-decoration" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
          <p className="auth-account-note">{m.accountOnly}</p>
        </div>
        <form className="form-panel auth-form" onSubmit={submit}>
          <div className="panel-heading">
            <LockKeyhole size={22} />
            <h2>{m.signIn}</h2>
          </div>
          <fieldset disabled={busy}>
            <Field label={m.email}>
              <input
                type="email"
                autoComplete="username"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label={m.password}>
              <input
                type="password"
                autoComplete="current-password"
                required
                maxLength={MAX_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <ErrorNotice error={error} />
            <button
              className="button button-primary full-width"
              type="submit"
              disabled={busy}
            >
              {busy ? m.signingIn : m.signIn}
              <ArrowRight size={17} />
            </button>
          </fieldset>
          <p className="auth-help">{m.loginHelp}</p>
        </form>
      </div>
    </div>
  );
}

export function InvitationPage({ reset = false }: { reset?: boolean }) {
  const m = useMessages();
  const locale = useLocale();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const invitation = useApi<{
    invitation: {
      email: string;
      displayName: string;
      kind: "invite" | "reset";
      expiresAt: string;
    };
  }>(token ? `/api/invitations?token=${encodeURIComponent(token)}` : null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const isReset = reset || invitation.data?.invitation.kind === "reset";
  useEffect(() => {
    // Keep invitation URLs out of the browser's referrer on external navigation.
    const existing = document.querySelector('meta[name="referrer"]');
    const old = existing?.getAttribute("content");
    const meta = existing ?? document.createElement("meta");
    meta.setAttribute("name", "referrer");
    meta.setAttribute("content", "no-referrer");
    if (!existing) document.head.appendChild(meta);
    return () => {
      if (existing && old) meta.setAttribute("content", old);
      else if (!existing) meta.remove();
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirmation) {
      setError("PASSWORD_MISMATCH");
      return;
    }
    setBusy(true);
    try {
      await api("/api/invitations/redeem", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      setPassword("");
      setConfirmation("");
      setDone(true);
      window.history.replaceState(
        {},
        "",
        `/${locale}/${reset ? "reset" : "invite"}`,
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="container invitation-page">
      <div className="invitation-symbol">
        <KeyRound size={28} />
      </div>
      <PageIntro
        eyebrow={m.loginEyebrow}
        title={isReset ? m.resetTitle : m.inviteTitle}
        description={isReset ? m.resetIntro : m.inviteIntro}
      />
      <div className="form-panel">
        {done ? (
          <div className="success-panel">
            <CheckCircle2 size={36} />
            <h2>{m.accountReady}</h2>
            <Link
              className="button button-primary"
              href={localeHref(locale, "/login")}
            >
              {m.signIn}
              <ArrowRight size={16} />
            </Link>
          </div>
        ) : invitation.loading ? (
          <Loading />
        ) : !token || invitation.error || !invitation.data ? (
          <Notice tone="error">{m.invalidInvitation}</Notice>
        ) : (
          <form onSubmit={submit}>
            <fieldset disabled={busy}>
              <p className="invite-identity">
                <span>{m.invitedAs}</span>
                <strong>{invitation.data.invitation.displayName}</strong>
                <span>{invitation.data.invitation.email}</span>
              </p>
              <Field label={m.newPassword} hint={m.passwordHint}>
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  maxLength={MAX_PASSWORD_LENGTH}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field label={m.confirmPassword}>
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  maxLength={MAX_PASSWORD_LENGTH}
                  required
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </Field>
              {error === "PASSWORD_MISMATCH" ? (
                <Notice tone="error">{m.passwordMismatch}</Notice>
              ) : (
                <ErrorNotice error={error} />
              )}
              <button
                className="button button-primary full-width"
                disabled={busy}
                type="submit"
              >
                {busy ? m.submitting : isReset ? m.resetPassword : m.activate}
                <ArrowRight size={16} />
              </button>
            </fieldset>
          </form>
        )}
      </div>
    </div>
  );
}
