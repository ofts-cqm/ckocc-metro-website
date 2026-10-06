"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { upload } from "@vercel/blob/client";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  FileJson,
  GitPullRequest,
  ImageIcon,
  LoaderCircle,
  Plus,
  Trash2,
  UploadCloud,
} from "lucide-react";
import type {
  EditSession,
  IssueSummary,
  PublishedMap,
  UpdateSummary,
  UploadAsset,
} from "@/lib/contracts";
import { updateSchema } from "@/lib/schemas";
import {
  api,
  ApiError,
  EmptyState,
  ErrorNotice,
  ExternalAnchor,
  Field,
  formatDate,
  Loading,
  Notice,
  OperationProgress,
  PageIntro,
  Protected,
  readReceipt,
  StatusBadge,
  useApi,
  useAuth,
  useDraft,
  useLocale,
  useMessages,
  type Receipt,
} from "./ui";

type UpdateDraft = {
  session: EditSession | null;
  summary: string;
  details: string;
  issueNumbers: number[];
  jsonName: string;
  pngName: string;
  idempotencyKey: string | null;
  submittedOperation: string | null;
};
const emptyDraft: UpdateDraft = {
  session: null,
  summary: "",
  details: "",
  issueNumbers: [],
  jsonName: "",
  pngName: "",
  idempotencyKey: null,
  submittedOperation: null,
};

export function UpdatesPage() {
  const m = useMessages();
  return (
    <div className="container updates-page">
      <PageIntro
        eyebrow={m.updatesEyebrow}
        title={m.updatesTitle}
        description={m.updatesIntro}
      />
      <Protected>
        <UpdatesWorkspace />
      </Protected>
    </div>
  );
}
function UpdatesWorkspace() {
  const m = useMessages();
  const locale = useLocale();
  const { user } = useAuth();
  const [draft, setDraft, clearDraft, ready] = useDraft<UpdateDraft>(
    `update-${user?.id}-v1`,
    emptyDraft,
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [baseCommit, setBaseCommit] = useState("");
  const [uploading, setUploading] = useState<"json" | "png" | null>(null);
  const [percent, setPercent] = useState(0);
  const [previewError, setPreviewError] = useState(false);
  const [issuePage, setIssuePage] = useState(1);
  const history = useApi<{
    updates: UpdateSummary[];
    pendingOthers?: UpdateSummary[];
  }>("/api/updates");
  const issues = useApi<{ issues: IssueSummary[]; hasMore: boolean }>(
    draft.session ? `/api/issues?state=open&page=${issuePage}` : null,
  );
  const currentMap = useApi<{ map: PublishedMap | null }>("/api/map");
  const reconciledSession = useRef<string | null>(null);
  useEffect(() => {
    setPreviewError(false);
  }, [draft.session?.assets?.png?.pathname]);
  useEffect(() => {
    const id = draft.session?.id;
    if (!ready || !id || reconciledSession.current === id) return;
    reconciledSession.current = id;
    let alive = true;
    api<{ editSession: EditSession }>(`/api/edit-sessions/${id}`)
      .then((value) => {
        if (alive)
          setDraft((previous) => ({ ...previous, session: value.editSession }));
      })
      .catch((e) => {
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [ready, draft.session?.id, setDraft]);
  const stale = Boolean(
    draft.session &&
    currentMap.data?.map &&
    draft.session.baseMapRevision !== currentMap.data.map.revision,
  );
  const hasFiles = Boolean(
    draft.session?.assets?.json && draft.session?.assets?.png,
  );
  const receipt: Receipt | null = draft.submittedOperation
    ? { id: draft.submittedOperation }
    : null;
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const value = await api<{ editSession: EditSession }>(
        "/api/edit-sessions",
        {
          method: "POST",
          body: JSON.stringify(
            baseCommit.trim()
              ? { baseCommit: baseCommit.trim().toLowerCase() }
              : {},
          ),
        },
      );
      setDraft({
        ...emptyDraft,
        session: value.editSession,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function stage(file: File | undefined, kind: "json" | "png") {
    if (!file || !draft.session || uploading) return;
    setError(null);
    if (file.size > (kind === "json" ? 2 : 20) * 1024 * 1024) {
      setError(new ApiError("FILE_TOO_LARGE"));
      return;
    }
    if (!file.name.toLowerCase().endsWith(`.${kind}`)) {
      setError(new ApiError("INVALID_FORMAT"));
      return;
    }
    setUploading(kind);
    setPercent(0);
    try {
      const reserved = await api<{ upload: { id: string; pathname: string } }>(
        "/api/uploads/reserve",
        {
          method: "POST",
          body: JSON.stringify({ editSessionId: draft.session.id, kind }),
        },
      );
      await upload(reserved.upload.pathname, file, {
        access: "private",
        handleUploadUrl: "/api/uploads/token",
        clientPayload: JSON.stringify({ uploadId: reserved.upload.id }),
        contentType: kind === "json" ? "application/json" : "image/png",
        onUploadProgress: (event) => setPercent(Math.round(event.percentage)),
      });
      const completed = await api<{ upload: UploadAsset }>(
        "/api/uploads/complete",
        {
          method: "POST",
          body: JSON.stringify({ uploadId: reserved.upload.id }),
        },
      );
      const asset: UploadAsset = {
        pathname: completed.upload.pathname || reserved.upload.pathname,
        bytes: completed.upload.bytes ?? file.size,
        sha256: completed.upload.sha256,
      };
      setDraft((previous) => ({
        ...previous,
        [`${kind}Name`]: file.name,
        idempotencyKey: crypto.randomUUID(),
        session: previous.session
          ? {
              ...previous.session,
              assets: { ...previous.session.assets, [kind]: asset },
            }
          : null,
      }));
      if (kind === "png") setPreviewError(false);
    } catch (e) {
      setError(e);
    } finally {
      setUploading(null);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !draft.session || receipt) return;
    setError(null);
    if (!hasFiles) {
      setError("REQUIRED_FILES");
      return;
    }
    const parsed = updateSchema.safeParse({
      editSessionId: draft.session.id,
      summary: draft.summary,
      details: draft.details,
      issueNumbers: draft.issueNumbers,
    });
    if (!parsed.success) {
      setError(new ApiError("VALIDATION_ERROR"));
      return;
    }
    const key = draft.idempotencyKey || crypto.randomUUID();
    if (!draft.idempotencyKey) setDraft((d) => ({ ...d, idempotencyKey: key }));
    setBusy(true);
    try {
      const value = await api<{
        operation?: { id: string };
        operationId?: string;
      }>("/api/updates", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify(parsed.data),
      });
      const operation = readReceipt(value);
      setDraft((d) => ({ ...d, submittedOperation: operation.id }));
      history.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const change = (value: Partial<UpdateDraft>) =>
    setDraft((previous) => ({
      ...previous,
      ...value,
      idempotencyKey: crypto.randomUUID(),
    }));
  function discard() {
    if (!window.confirm(m.discardConfirm)) return;
    clearDraft();
    setPreviewError(false);
    setError(null);
    reconciledSession.current = null;
  }
  return (
    <>
      <ol className="workflow-steps">
        {[m.stepStart, m.stepUpload, m.stepReview].map((label, i) => (
          <li
            className={
              (i === 0 && draft.session) ||
              (i === 1 && hasFiles) ||
              (i === 2 && receipt)
                ? "complete"
                : ""
            }
            key={label}
          >
            <span>
              {(i === 0 && draft.session) ||
              (i === 1 && hasFiles) ||
              (i === 2 && receipt) ? (
                <Check size={15} />
              ) : (
                i + 1
              )}
            </span>
            {label}
          </li>
        ))}
      </ol>
      {!ready ? (
        <Loading />
      ) : !draft.session ? (
        <section className="start-update-panel form-panel">
          <div className="start-icon">
            <GitPullRequest size={32} />
          </div>
          <h2>{m.startUpdate}</h2>
          <p>{m.editingNotice}</p>
          <details className="known-base">
            <summary>{m.baseKnown}</summary>
            <p>{m.baseKnownHelp}</p>
            <Field label={m.baseCommit}>
              <input
                className="mono"
                value={baseCommit}
                maxLength={40}
                pattern="[a-fA-F0-9]{40}"
                onChange={(e) => setBaseCommit(e.target.value)}
              />
            </Field>
          </details>
          <ErrorNotice error={error} />
          <button
            className="button button-primary"
            disabled={
              busy ||
              Boolean(baseCommit && !/^[a-fA-F0-9]{40}$/.test(baseCommit))
            }
            onClick={start}
          >
            {busy ? m.loading : m.startUpdate}
            <ArrowRight size={17} />
          </button>
        </section>
      ) : receipt ? (
        <div className="form-panel">
          <h2>{m.updateAccepted}</h2>
          <p>{m.updateAcceptedBody}</p>
          <OperationProgress receipt={receipt} onSuccess={history.refresh} />
          <button
            className="button button-secondary"
            onClick={() => {
              clearDraft();
              setError(null);
              setPreviewError(false);
            }}
          >
            {m.startUpdate}
            <Plus size={16} />
          </button>
        </div>
      ) : (
        <form className="update-form" onSubmit={submit}>
          <section className="edit-session-bar">
            <div>
              <span>{m.startVersion}</span>
              <strong className="mono" title={draft.session.baseCommit}>
                {draft.session.baseCommit.slice(0, 12)}
              </strong>
            </div>
            <a
              className="button button-secondary"
              href={draft.session.sourceUrl}
            >
              <ArrowDownToLine size={16} />
              {m.downloadSource}
            </a>
            <ExternalAnchor
              className="button button-secondary"
              href="https://railmapgen.org/rmp/"
            >
              {m.openEditor}
            </ExternalAnchor>
          </section>
          {stale && <Notice tone="warning">{m.freshnessWarning}</Notice>}
          <Notice>{m.editingNotice}</Notice>
          {Boolean(history.data?.pendingOthers?.length) && (
            <div className="pending-updates">
              <h3>{m.pendingUpdates}</h3>
              <p>{m.pendingNotice}</p>
              {history.data?.pendingOthers?.map((other) => (
                <div key={other.id}>
                  <StatusBadge status={other.status} />
                  <span>{other.summary}</span>
                  {other.prUrl && (
                    <ExternalAnchor href={other.prUrl}>
                      {other.prNumber ? `#${other.prNumber}` : m.github}
                    </ExternalAnchor>
                  )}
                </div>
              ))}
            </div>
          )}
          <fieldset
            className="form-panel"
            disabled={busy || Boolean(uploading)}
          >
            <div className="panel-heading">
              <UploadCloud size={24} />
              <h2>{m.stepUpload}</h2>
            </div>
            <div className="upload-grid">
              {(["json", "png"] as const).map((kind) => {
                const asset = draft.session?.assets?.[kind];
                const name = kind === "json" ? draft.jsonName : draft.pngName;
                return (
                  <label
                    key={kind}
                    className={`upload-dropzone ${asset ? "has-file" : ""}`}
                  >
                    <input
                      className="sr-only"
                      type="file"
                      accept={
                        kind === "json"
                          ? ".json,application/json"
                          : ".png,image/png"
                      }
                      disabled={busy || Boolean(uploading)}
                      onChange={(e) => {
                        void stage(e.target.files?.[0], kind);
                        e.currentTarget.value = "";
                      }}
                    />
                    <span className="upload-icon">
                      {uploading === kind ? (
                        <LoaderCircle className="spin" size={27} />
                      ) : asset ? (
                        <Check size={27} />
                      ) : kind === "json" ? (
                        <FileJson size={27} />
                      ) : (
                        <ImageIcon size={27} />
                      )}
                    </span>
                    <strong>
                      {kind === "json" ? m.uploadJson : m.uploadPng}
                    </strong>
                    <span className="upload-filename">
                      {name || (kind === "json" ? m.jsonLimit : m.pngLimit)}
                    </span>
                    <span className="upload-action">
                      {uploading === kind
                        ? `${m.uploading} ${percent}%`
                        : asset
                          ? m.replaceFile
                          : m.chooseFile}
                    </span>
                    {uploading === kind && (
                      <progress
                        max={100}
                        value={percent}
                        aria-label={m.uploading}
                      />
                    )}
                  </label>
                );
              })}
            </div>
            {draft.session.assets?.png && (
              <div className="upload-review">
                <div>
                  <ImageIcon size={17} />
                  <strong>{m.reviewImage}</strong>
                </div>
                {previewError ? (
                  <p className="field-hint">{m.uploadPreviewUnavailable}</p>
                ) : (
                  <img
                    src={`/api/edit-sessions/${draft.session.id}/preview?v=${encodeURIComponent(draft.session.assets.png.pathname)}`}
                    alt={m.uploadPreview}
                    className="upload-preview"
                    onError={() => setPreviewError(true)}
                  />
                )}
              </div>
            )}
            <Field label={m.summary} hint={m.summaryHint}>
              <input
                required
                maxLength={160}
                value={draft.summary}
                onChange={(e) => change({ summary: e.target.value })}
              />
            </Field>
            <Field label={m.details} optional>
              <textarea
                rows={4}
                maxLength={5000}
                value={draft.details}
                onChange={(e) => change({ details: e.target.value })}
              />
            </Field>
            <div className="form-divider" />
            <div className="resolve-heading">
              <h3>
                {m.resolveIssues}
                <span className="count-pill">{draft.issueNumbers.length}</span>
              </h3>
              <p>{m.resolveHelp}</p>
            </div>
            {issues.loading ? (
              <Loading />
            ) : issues.error ? (
              <ErrorNotice error={issues.error} />
            ) : issues.data?.issues.length ? (
              <div className="issue-selection">
                {issues.data.issues
                  .filter((issue) => !issue.locked)
                  .map((issue) => (
                    <label className="issue-checkbox" key={issue.number}>
                      <input
                        type="checkbox"
                        checked={draft.issueNumbers.includes(issue.number)}
                        disabled={
                          !draft.issueNumbers.includes(issue.number) &&
                          draft.issueNumbers.length >= 50
                        }
                        onChange={(e) =>
                          change({
                            issueNumbers: e.target.checked
                              ? [...draft.issueNumbers, issue.number]
                              : draft.issueNumbers.filter(
                                  (n) => n !== issue.number,
                                ),
                          })
                        }
                      />
                      <span className="mono">#{issue.number}</span>
                      <strong>{issue.title}</strong>
                    </label>
                  ))}
              </div>
            ) : (
              <p className="muted">{m.noEligibleIssues}</p>
            )}
            {(issuePage > 1 || issues.data?.hasMore) && (
              <div className="pagination">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={issuePage === 1}
                  onClick={() => setIssuePage((p) => p - 1)}
                >
                  {m.previous}
                </button>
                <span>
                  {m.page} {issuePage}
                </span>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!issues.data?.hasMore}
                  onClick={() => setIssuePage((p) => p + 1)}
                >
                  {m.next}
                </button>
              </div>
            )}
            <Notice>{m.reviewNotice}</Notice>
            <p className="field-hint">{m.pendingNotice}</p>
            {error === "REQUIRED_FILES" ? (
              <Notice tone="error">{m.requiredFiles}</Notice>
            ) : (
              <ErrorNotice error={error} />
            )}
            <div className="form-actions">
              <button
                type="button"
                className="text-button danger"
                onClick={discard}
              >
                <Trash2 size={15} />
                {m.abandonDraft}
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={busy || !hasFiles || stale || Boolean(uploading)}
              >
                {busy ? m.submitting : m.createPr}
                <GitPullRequest size={17} />
              </button>
            </div>
          </fieldset>
        </form>
      )}
      <section className="update-history">
        <div className="section-heading compact">
          <h2>{m.updateHistory}</h2>
        </div>
        {history.loading ? (
          <Loading />
        ) : history.error ? (
          <ErrorNotice error={history.error} />
        ) : history.data?.updates.length ? (
          <div className="history-list">
            {history.data.updates.map((value) => (
              <article className="history-item" key={value.id}>
                <span className="history-icon">
                  <GitPullRequest size={20} />
                </span>
                <div>
                  <h3>{value.summary}</h3>
                  <p>
                    {formatDate(value.createdAt, locale)}
                    <span className="dot-separator">·</span>
                    <span className="mono">
                      {value.baseMapRevision
                        .replace("sha256:", "")
                        .slice(0, 10)}
                    </span>
                  </p>
                  {value.errorCode && <ErrorNotice error={value.errorCode} />}
                </div>
                <div className="history-right">
                  <StatusBadge status={value.status} />
                  {value.prUrl && (
                    <ExternalAnchor href={value.prUrl}>
                      {value.prNumber ? `#${value.prNumber}` : m.github}
                    </ExternalAnchor>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<GitPullRequest size={25} />}
            title={m.noUpdates}
            description={m.noUpdatesBody}
          />
        )}
      </section>
    </>
  );
}
