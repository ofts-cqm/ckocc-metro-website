"use client";

import { useState, type FormEvent } from "react";
import {
  Check,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import type { OperationView } from "@/lib/contracts";
import { languageTags } from "@/lib/i18n";
import {
  api,
  EmptyState,
  ErrorNotice,
  Field,
  formatDate,
  Loading,
  Notice,
  PageIntro,
  Protected,
  StatusBadge,
  useApi,
  useAuth,
  useDraft,
  useLocale,
  useMessages,
} from "./ui";

type Account = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "collaborator";
  active: boolean;
  createdAt: string;
};
type Invitation = {
  id: string;
  url: string;
  expiresAt: string;
  email: string;
  role: string;
};
type InvitationRecord = Omit<Invitation, "url"> & {
  displayName: string;
  kind: "invite" | "reset";
  consumedAt: string | null;
  revokedAt: string | null;
};
export function AdminPage() {
  const m = useMessages();
  return (
    <div className="container admin-page">
      <PageIntro
        eyebrow={m.adminEyebrow}
        title={m.adminTitle}
        description={m.adminIntro}
      />
      <Protected admin>
        <AdminWorkspace />
      </Protected>
    </div>
  );
}
function AdminWorkspace() {
  const m = useMessages();
  const locale = useLocale();
  const { user } = useAuth();
  const accounts = useApi<{ accounts: Account[] }>("/api/admin/accounts");
  const settings = useApi<{ publicWritesPaused: boolean }>(
    "/api/admin/settings",
  );
  const invitations = useApi<{ invitations: InvitationRecord[] }>(
    "/api/admin/invitations",
  );
  const operations = useApi<{ operations: OperationView[] }>(
    "/api/admin/operations",
  );
  const [inviteDraft, setInviteDraft] = useDraft(`admin-invite-${user?.id}`, {
    email: "",
    displayName: "",
    role: "collaborator",
  });
  const { email, displayName, role } = inviteDraft;
  const setEmail = (email: string) => setInviteDraft((d) => ({ ...d, email }));
  const setDisplayName = (displayName: string) =>
    setInviteDraft((d) => ({ ...d, displayName }));
  const setRole = (role: string) => setInviteDraft((d) => ({ ...d, role }));
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  async function createInvite(event: FormEvent) {
    event.preventDefault();
    setBusy("invite");
    setError(null);
    try {
      const value = await api<{ invitation: Invitation }>(
        "/api/admin/invitations",
        {
          method: "POST",
          body: JSON.stringify({
            email,
            displayName,
            role,
            locale: languageTags[locale],
          }),
        },
      );
      setInvitation(value.invitation);
      setCopied(false);
      setEmail("");
      setDisplayName("");
      invitations.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  async function accountAction(
    id: string,
    action: "disable" | "enable" | "reset",
  ) {
    setBusy(id);
    setError(null);
    try {
      const value = await api<{ invitation?: Invitation }>(
        `/api/admin/accounts/${id}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ locale: languageTags[locale] }),
        },
      );
      if (value.invitation) {
        setInvitation(value.invitation);
        setCopied(false);
      }
      accounts.refresh();
      invitations.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/admin/invitations/${id}`, { method: "DELETE" });
      invitations.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  const attentionOperations =
    operations.data?.operations.filter((value) =>
      ["failed", "outcome_unknown", "needs_reconciliation"].includes(
        value.status,
      ),
    ) ?? [];
  const pendingInvitations =
    invitations.data?.invitations.filter(
      (value) =>
        !value.consumedAt &&
        !value.revokedAt &&
        Date.parse(value.expiresAt) > Date.now(),
    ) ?? [];
  async function pause() {
    setBusy("settings");
    setError(null);
    setNotice(null);
    try {
      await api("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          publicWritesPaused: !settings.data?.publicWritesPaused,
        }),
      });
      settings.refresh();
      setNotice(m.settingsSaved);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  async function recover(id?: string) {
    setBusy(id || "sync");
    setError(null);
    setNotice(null);
    try {
      await api(id ? `/api/admin/operations/${id}/retry` : "/api/admin/sync", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: "{}",
      });
      operations.refresh();
      setNotice(m.syncQueued);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <ErrorNotice error={error} />
      {notice && <Notice tone="success">{notice}</Notice>}
      {invitation && (
        <section className="invitation-result form-panel">
          <div className="panel-heading">
            <KeyRound size={23} />
            <h2>{m.invitationCreated}</h2>
          </div>
          <p>{m.privateLinkNotice}</p>
          <p>
            <strong>{invitation.email}</strong>
            <span className="dot-separator">·</span>
            {formatDate(invitation.expiresAt, locale)}
          </p>
          <div className="copy-field">
            <input
              type="text"
              readOnly
              value={invitation.url}
              aria-label={m.invitationCreated}
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="button button-primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(invitation.url);
                  setCopied(true);
                } catch {
                  /* The field remains selectable. */
                }
              }}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
              {copied ? m.copied : m.copy}
            </button>
          </div>
          <button className="text-button" onClick={() => setInvitation(null)}>
            {m.close}
          </button>
        </section>
      )}
      <div className="admin-grid">
        <section className="form-panel">
          <div className="panel-heading">
            <UserRound size={22} />
            <h2>{m.inviteCollaborator}</h2>
          </div>
          <form onSubmit={createInvite}>
            <fieldset disabled={Boolean(busy)}>
              <Field label={m.email}>
                <input
                  required
                  type="email"
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label={m.displayName}>
                <input
                  required
                  maxLength={64}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </Field>
              <Field label={m.role}>
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="collaborator">{m.collaborator}</option>
                  <option value="admin">{m.administrator}</option>
                </select>
              </Field>
              <button type="submit" className="button button-primary">
                {busy === "invite" ? m.submitting : m.sendInvite}
                <Plus size={16} />
              </button>
            </fieldset>
          </form>
        </section>
        <div className="admin-controls">
          <section className="form-panel">
            <div className="panel-heading">
              <ShieldCheck size={22} />
              <h2>{m.publicSubmissions}</h2>
            </div>
            <p>{m.publicSubmissionsHelp}</p>
            {settings.error ? (
              <ErrorNotice error={settings.error} />
            ) : (
              <label className="switch-row">
                <span>{m.pauseSubmissions}</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={settings.data?.publicWritesPaused ?? false}
                  disabled={settings.loading || Boolean(busy)}
                  onChange={() => void pause()}
                />
              </label>
            )}
          </section>
          <section className="form-panel">
            <div className="panel-heading">
              <RefreshCw size={22} />
              <h2>{m.recovery}</h2>
            </div>
            <p>{m.recoveryHelp}</p>
            <button
              className="button button-secondary"
              disabled={Boolean(busy)}
              onClick={() => void recover()}
            >
              <RefreshCw size={15} className={busy === "sync" ? "spin" : ""} />
              {m.synchronize}
            </button>
          </section>
        </div>
      </div>
      <section className="admin-accounts">
        <div className="section-heading compact">
          <h2>
            {m.accounts}
            <span className="count-pill">
              {accounts.data?.accounts.length ?? "—"}
            </span>
          </h2>
        </div>
        {accounts.loading ? (
          <Loading />
        ) : accounts.error ? (
          <ErrorNotice error={accounts.error} />
        ) : accounts.data?.accounts.length ? (
          <div className="account-list">
            {accounts.data.accounts.map((account) => (
              <article className="account-card" key={account.id}>
                <div className="avatar">
                  {account.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="account-info">
                  <strong>{account.name}</strong>
                  <span>{account.email}</span>
                  <small>
                    {account.role === "admin"
                      ? m.administrator
                      : m.collaborator}
                    <span className="dot-separator">·</span>
                    {account.active ? m.enabled : m.disabled}
                  </small>
                </div>
                <div className="account-actions">
                  <button
                    className="button button-secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void accountAction(account.id, "reset")}
                  >
                    <KeyRound size={14} />
                    {m.issueReset}
                  </button>
                  <button
                    className={`button ${account.active ? "button-danger" : "button-secondary"}`}
                    disabled={Boolean(busy) || account.id === user?.id}
                    onClick={() =>
                      void accountAction(
                        account.id,
                        account.active ? "disable" : "enable",
                      )
                    }
                  >
                    {account.active ? m.disable : m.enable}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title={m.noAccounts} />
        )}
      </section>
      <section className="admin-invitations">
        <div className="section-heading compact">
          <h2>
            {m.pendingInvitations}
            <span className="count-pill">{pendingInvitations.length}</span>
          </h2>
        </div>
        {invitations.loading ? (
          <Loading />
        ) : invitations.error ? (
          <ErrorNotice error={invitations.error} />
        ) : pendingInvitations.length ? (
          <div className="account-list">
            {pendingInvitations.map((invite) => (
              <article className="account-card" key={invite.id}>
                <span className="avatar">
                  <KeyRound size={17} />
                </span>
                <div className="account-info">
                  <strong>{invite.displayName || invite.email}</strong>
                  <span>{invite.email}</span>
                  <small>
                    {invite.kind === "reset"
                      ? m.resetPassword
                      : invite.role === "admin"
                        ? m.administrator
                        : m.collaborator}
                    <span className="dot-separator">·</span>
                    {m.expires} {formatDate(invite.expiresAt, locale)}
                  </small>
                </div>
                <button
                  className="button button-danger"
                  disabled={Boolean(busy)}
                  onClick={() => void revoke(invite.id)}
                >
                  {m.revokeInvitation}
                </button>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title={m.noInvitations} />
        )}
      </section>
      <section className="admin-operations">
        <div className="section-heading compact">
          <h2>{m.failedOperations}</h2>
        </div>
        {operations.loading ? (
          <Loading />
        ) : operations.error ? (
          <ErrorNotice error={operations.error} />
        ) : attentionOperations.length ? (
          <div className="history-list">
            {attentionOperations.map((operation) => (
              <article className="history-item" key={operation.id}>
                <div>
                  <strong className="mono">{operation.id.slice(0, 12)}</strong>
                  <p>{formatDate(operation.updatedAt, locale)}</p>
                  {operation.errorCode && (
                    <ErrorNotice error={operation.errorCode} />
                  )}
                </div>
                <StatusBadge status={operation.status} />
                {["failed", "outcome_unknown"].includes(operation.status) && (
                  <button
                    className="button button-secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void recover(operation.id)}
                  >
                    {m.retryOperation}
                    <RefreshCw size={15} />
                  </button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title={m.noFailedOperations} />
        )}
      </section>
    </>
  );
}
