"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Globe2,
  LoaderCircle,
  LogOut,
  Menu,
  TrainFront,
  X,
} from "lucide-react";
import {
  catalogs,
  languageNames,
  languageTags,
  locales,
  type Locale,
  type MessageKey,
} from "@/lib/i18n";
import type { OperationView, SessionUser } from "@/lib/contracts";

const LocaleContext = createContext<Locale>("en-us");
export const useLocale = () => useContext(LocaleContext);
export const useMessages = () => catalogs[useLocale()];
export const localeHref = (locale: Locale, path = "") => `/${locale}${path}`;
export function formatDate(date: string, locale: Locale) {
  const value = new Date(date);
  return Number.isNaN(value.getTime())
    ? "—"
    : new Intl.DateTimeFormat(languageTags[locale], {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(value);
}
export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code);
  }
}
export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      credentials: "same-origin",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError("NETWORK_ERROR");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      body?.error?.code ??
        body?.code ??
        (response.status === 503
          ? "SERVICE_UNAVAILABLE"
          : response.status === 401
            ? "UNAUTHORIZED"
            : "UNKNOWN"),
      response.status,
    );
  return body as T;
}
export function errorKey(error: unknown): MessageKey {
  const code = (
    error instanceof ApiError
      ? error.code
      : typeof error === "string"
        ? error
        : ""
  ).toUpperCase();
  if (/ACCOUNT_EXISTS/.test(code)) return "accountExists";
  if (/CANNOT_DISABLE_SELF/.test(code)) return "cannotDisableSelf";
  if (/LAST_ADMIN/.test(code)) return "lastAdmin";
  if (/FRESH_AUTH/.test(code)) return "freshAuth";
  if (/NETWORK/.test(code)) return "errorNetwork";
  if (/RATE|LIMIT_EXCEEDED/.test(code)) return "errorRateLimit";
  if (/PAUSED/.test(code)) return "errorPaused";
  if (/CREDENTIAL|INVALID_EMAIL_OR_PASSWORD|PASSWORD_INVALID/.test(code))
    return "errorCredentials";
  if (/UNAUTH|SESSION_EXPIRED|NOT_AUTHENTICATED/.test(code))
    return "errorUnauthorized";
  if (/FORBIDDEN|DISABLED|ACCESS_DENIED/.test(code)) return "errorForbidden";
  if (/STALE|RECONCILIATION/.test(code)) return "errorStale";
  if (/TOO_LARGE|SIZE|PIXEL/.test(code)) return "errorTooLarge";
  if (/INVITATION|INVITE|TOKEN_EXPIRED|INVALID_LINK/.test(code))
    return "errorInvitation";
  if (/CLOSED|LOCKED/.test(code)) return "errorClosed";
  if (/CONFLICT|IDEMPOTENCY/.test(code)) return "errorConflict";
  if (/CHALLENGE|TURNSTILE|BOT/.test(code)) return "challengeRequired";
  if (/VALIDATION|INVALID_INPUT|BAD_REQUEST|INVALID_BODY/.test(code))
    return "errorValidation";
  if (/UPLOAD|FORMAT|INVALID_JSON|INVALID_PNG/.test(code)) return "errorFile";
  if (/UNAVAILABLE|NOT_CONFIGURED|CONFIGURATION/.test(code))
    return "errorUnavailable";
  return "errorGeneric";
}
export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!url) {
      setLoading(false);
      setData(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    api<T>(url)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [url, version]);
  return {
    data,
    error,
    loading,
    refresh: useCallback(() => setVersion((v) => v + 1), []),
  };
}
export function useDraft<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>, () => void, boolean] {
  const [draft, setDraft] = useState(initial);
  const [ready, setReady] = useState(false);
  const initialRef = useRef(initial);
  const draftRef = useRef(initial);
  useEffect(() => {
    let value = initialRef.current;
    try {
      const raw = sessionStorage.getItem(`metro:${key}`);
      if (raw) value = JSON.parse(raw) as T;
    } catch {
      /* Storage may be disabled. */
    }
    draftRef.current = value;
    setDraft(value);
    setReady(true);
  }, [key]);
  const update: Dispatch<SetStateAction<T>> = useCallback(
    (value) => {
      const next =
        typeof value === "function"
          ? (value as (p: T) => T)(draftRef.current)
          : value;
      draftRef.current = next;
      try {
        sessionStorage.setItem(`metro:${key}`, JSON.stringify(next));
      } catch {
        /* Keep the in-memory draft. */
      }
      setDraft(next);
    },
    [key],
  );
  const clear = useCallback(() => {
    try {
      sessionStorage.removeItem(`metro:${key}`);
    } catch {
      /* No storage available. */
    }
    draftRef.current = initialRef.current;
    setDraft(initialRef.current);
  }, [key]);
  return [draft, update, clear, ready];
}
type AuthState = {
  user: SessionUser | null;
  loading: boolean;
  refresh: () => void;
};
const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  refresh: () => {},
});
export const useAuth = () => useContext(AuthContext);
export function SiteShell({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const m = catalogs[locale];
  const pathname = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const auth = useApi<{ user: SessionUser | null }>("/api/auth/session");
  useEffect(() => {
    document.documentElement.lang = languageTags[locale];
    setMenu(false);
  }, [locale, pathname]);
  function changeLanguage(next: string) {
    const path = pathname.replace(/^\/(en-us|zh-cn|zh-hk)(?=\/|$)/, `/${next}`);
    document.cookie = `metro-locale=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
    router.push(`${path}${window.location.search}${window.location.hash}`);
  }
  return (
    <LocaleContext.Provider value={locale}>
      <AuthContext.Provider
        value={{
          user: auth.data?.user ?? null,
          loading: auth.loading,
          refresh: auth.refresh,
        }}
      >
        <a className="skip-link" href="#main-content">
          {m.skipContent}
        </a>
        <header className="site-header">
          <div className="header-inner">
            <Link
              className="wordmark"
              href={localeHref(locale)}
              aria-label={m.home}
            >
              <span className="brand-mark">
                <TrainFront size={25} strokeWidth={2.3} />
              </span>
              <span>
                {m.brand}
                <small>{m.brandSub}</small>
              </span>
            </Link>
            <nav className="desktop-nav" aria-label={m.menu}>
              <Link
                className={pathname === `/${locale}` ? "active" : ""}
                href={localeHref(locale)}
              >
                {m.map}
              </Link>
              <Link href={localeHref(locale, "/#requests")}>{m.requests}</Link>
              {auth.data?.user && (
                <Link
                  className={pathname.endsWith("/updates") ? "active" : ""}
                  href={localeHref(locale, "/updates")}
                >
                  {m.updates}
                </Link>
              )}
              {auth.data?.user?.role === "admin" && (
                <Link href={localeHref(locale, "/admin")}>{m.admin}</Link>
              )}
            </nav>
            <div className="header-actions">
              <div className="language-select">
                <Globe2 size={16} />
                <select
                  aria-label={m.language}
                  value={locale}
                  onChange={(e) => changeLanguage(e.target.value)}
                >
                  {locales.map((value) => (
                    <option key={value} value={value}>
                      {languageNames[value]}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </div>
              {auth.data?.user ? (
                <button
                  className="icon-button header-signout"
                  aria-label={m.logout}
                  title={m.logout}
                  onClick={async () => {
                    try {
                      await api("/api/auth/sign-out", {
                        method: "POST",
                        body: "{}",
                      });
                      auth.refresh();
                      router.push(localeHref(locale));
                    } catch {
                      /* Session remains visible until confirmed logout. */
                    }
                  }}
                >
                  <LogOut size={17} />
                </button>
              ) : (
                <Link
                  className="header-login"
                  href={localeHref(locale, "/login")}
                >
                  {m.login}
                  <ArrowRight size={14} />
                </Link>
              )}
              <button
                className="icon-button mobile-menu-button"
                aria-label={m.menu}
                aria-expanded={menu}
                onClick={() => setMenu((v) => !v)}
              >
                {menu ? <X size={20} /> : <Menu size={20} />}
              </button>
            </div>
          </div>
          {menu && (
            <nav className="mobile-nav" aria-label={m.menu}>
              <Link href={localeHref(locale)}>{m.map}</Link>
              <Link href={localeHref(locale, "/#requests")}>{m.requests}</Link>
              <Link
                href={localeHref(
                  locale,
                  auth.data?.user ? "/updates" : "/login",
                )}
              >
                {auth.data?.user ? m.updates : m.login}
              </Link>
              {auth.data?.user?.role === "admin" && (
                <Link href={localeHref(locale, "/admin")}>{m.admin}</Link>
              )}
            </nav>
          )}
        </header>
        <main id="main-content">{children}</main>
        <footer className="site-footer">
          <div>
            <span className="footer-stations" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <strong>{m.footer}</strong>
            <p>{m.footerNote}</p>
          </div>
          <a href="https://railmapgen.org" target="_blank" rel="noreferrer">
            {m.footerEditor}
            <ExternalLink size={13} />
          </a>
        </footer>
      </AuthContext.Provider>
    </LocaleContext.Provider>
  );
}
export function PageIntro({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-intro">
      <span className="eyebrow">
        <span />
        {eyebrow}
      </span>
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
export function Field({
  label,
  hint,
  optional,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const m = useMessages();
  return (
    <label className={`field ${className}`}>
      <span className="field-label">
        {label}
        {optional && <small>{m.optional}</small>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "error" | "success" | "warning";
}) {
  return (
    <div
      className={`notice notice-${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {tone === "success" ? <Check size={18} /> : <CircleAlert size={18} />}
      <div>{children}</div>
    </div>
  );
}
export function ErrorNotice({ error }: { error: unknown }) {
  const m = useMessages();
  const locale = useLocale();
  return error ? (
    <Notice tone="error">
      {m[errorKey(error)]}
      {errorKey(error) === "freshAuth" && (
        <Link href={localeHref(locale, "/login?next=admin")}>
          {m.signInAgain}
          <ArrowRight size={14} />
        </Link>
      )}
    </Notice>
  ) : null;
}
export function Loading() {
  const m = useMessages();
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spin" size={22} />
      {m.loading}
    </div>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && <span className="empty-icon">{icon}</span>}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const m = useMessages();
  const key =
    status === "published"
      ? "published"
      : status === "accepted"
        ? "queued"
        : status;
  return (
    <span className={`status-badge status-${status}`}>
      <i />
      {key in m ? m[key as MessageKey] : m.processing}
    </span>
  );
}
export function ExternalAnchor({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const m = useMessages();
  let safe = false;
  try {
    safe = ["https:", "http:"].includes(new URL(href).protocol);
  } catch {
    /* Malformed link. */
  }
  return safe ? (
    <a
      className={className ?? "text-link"}
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {children}
      <ExternalLink size={14} />
      <span className="sr-only"> ({m.external})</span>
    </a>
  ) : (
    <span>{children}</span>
  );
}
export function Protected({
  children,
  admin = false,
}: {
  children: ReactNode;
  admin?: boolean;
}) {
  const { user, loading } = useAuth();
  const locale = useLocale();
  const m = useMessages();
  const pathname = usePathname();
  if (loading) return <Loading />;
  if (!user)
    return (
      <EmptyState
        icon={<TrainFront size={28} />}
        title={m.signedOut}
        description={m.signedOutBody}
      >
        <Link
          className="button button-primary"
          href={localeHref(
            locale,
            `/login?next=${encodeURIComponent(pathname)}`,
          )}
        >
          {m.signIn}
          <ArrowRight size={16} />
        </Link>
      </EmptyState>
    );
  if (admin && user.role !== "admin")
    return (
      <EmptyState title={m.forbiddenTitle} description={m.forbiddenBody} />
    );
  return <>{children}</>;
}
export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export type Receipt = { id: string; token?: string };
export function readReceipt(
  response: { operation?: { id: string }; operationId?: string; id?: string },
  token?: string,
): Receipt {
  const id = response.operation?.id ?? response.operationId ?? response.id;
  if (!id) throw new ApiError("UNKNOWN");
  return { id, token };
}
export function OperationProgress({
  receipt,
  onSuccess,
}: {
  receipt: Receipt;
  onSuccess?: (operation: OperationView) => void;
}) {
  const m = useMessages();
  const locale = useLocale();
  const [operation, setOperation] = useState<OperationView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pollVersion, setPollVersion] = useState(0);
  const success = useRef(onSuccess);
  const finished = useRef(false);
  success.current = onSuccess;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const value = await api<{ operation: OperationView }>(
          `/api/operations/${receipt.id}`,
          {
            headers: receipt.token ? { "X-Receipt-Token": receipt.token } : {},
          },
        );
        if (!alive) return;
        setOperation(value.operation);
        setError(null);
        failures = 0;
        if (
          ["succeeded", "awaiting_review", "merged", "published"].includes(
            value.operation.status,
          )
        ) {
          if (!finished.current) {
            finished.current = true;
            success.current?.(value.operation);
          }
          return;
        }
        if (
          [
            "needs_reconciliation",
            "closed_unmerged",
            "outcome_unknown",
          ].includes(value.operation.status) ||
          (value.operation.status === "failed" && !value.operation.retryAt)
        )
          return;
      } catch (e) {
        if (!alive) return;
        setError(e);
        failures++;
      }
      if (alive && failures < 6)
        timer = setTimeout(poll, Math.min(15000, 2500 * (failures + 1)));
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [receipt.id, receipt.token, pollVersion]);
  const status = operation?.status ?? "accepted";
  const done = ["succeeded", "awaiting_review", "merged", "published"].includes(
    status,
  );
  const issueNumber =
    operation?.result?.number ?? operation?.result?.issueNumber;
  const prUrl = operation?.result?.prUrl;
  const needsAttention =
    ["failed", "needs_reconciliation", "outcome_unknown"].includes(status) &&
    !operation?.retryAt;
  return (
    <div className="operation-progress" aria-live="polite">
      <div className="operation-title">
        {done ? (
          <Check size={21} />
        ) : needsAttention ? (
          <CircleAlert size={21} />
        ) : (
          <LoaderCircle className="spin" size={21} />
        )}
        <strong>
          {(status === "failed" && !operation?.retryAt) ||
          status === "needs_reconciliation"
            ? m.operationFailed
            : status === "outcome_unknown"
              ? m.operationUnknown
              : done
                ? m.succeeded
                : m.operationPending}
        </strong>
        <StatusBadge status={status} />
      </div>
      {operation?.errorCode && <ErrorNotice error={operation.errorCode} />}
      <ErrorNotice error={error} />
      {(error || needsAttention) && (
        <button
          className="text-button"
          type="button"
          onClick={() => setPollVersion((v) => v + 1)}
        >
          {m.retry}
        </button>
      )}
      {typeof issueNumber === "number" && (
        <Link
          className="text-link"
          href={localeHref(locale, `/issues/${issueNumber}`)}
        >
          {m.readRequest} #{issueNumber}
          <ArrowRight size={15} />
        </Link>
      )}
      {typeof prUrl === "string" && (
        <ExternalAnchor href={prUrl}>{m.github}</ExternalAnchor>
      )}
    </div>
  );
}
