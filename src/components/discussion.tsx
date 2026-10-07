"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, LockKeyhole, MessageCircle, UserRound } from "lucide-react";
import type { IssueComment, IssueDetail } from "@/lib/contracts";
import { CommentForm, lineTypeKey } from "./public-forms";
import {
  EmptyState,
  api,
  ErrorNotice,
  ExternalAnchor,
  formatDate,
  Loading,
  localeHref,
  Notice,
  OperationProgress,
  readReceipt,
  StatusBadge,
  useApi,
  useAuth,
  useLocale,
  useMessages,
  type Receipt,
} from "./ui";

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children: text }) =>
            href ? (
              <ExternalAnchor href={href}>{text}</ExternalAnchor>
            ) : (
              <>{text}</>
            ),
          img: ({ alt }) => <span className="muted">[{alt || "…"}]</span>,
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
function RequestContent({ issue }: { issue: IssueDetail }) {
  const m = useMessages();
  const locale = useLocale();
  const request = issue.request;
  if (!request) return <SafeMarkdown>{issue.body}</SafeMarkdown>;
  if (request.kind === "general")
    return <SafeMarkdown>{request.comment}</SafeMarkdown>;
  return (
    <>
      <dl className="request-attributes">
        {request.lineName && (
          <div>
            <dt>{m.lineName}</dt>
            <dd>{request.lineName}</dd>
          </div>
        )}
        {request.lineNumber && (
          <div>
            <dt>{m.lineNumber}</dt>
            <dd className="mono">{request.lineNumber}</dd>
          </div>
        )}
        <div>
          <dt>{m.lineType}</dt>
          <dd>{m[lineTypeKey(request.lineType)]}</dd>
        </div>
        <div>
          <dt>{m.operation}</dt>
          <dd>{m[request.operation]}</dd>
        </div>
      </dl>
      <h3>
        {m.stationTitle}
        <span className="count-pill">{request.stations.length}</span>
      </h3>
      <div className="station-table-wrap">
        <table className="station-table">
          <thead>
            <tr>
              <th>#</th>
              <th>{m.station}</th>
              <th>X</th>
              <th>Z</th>
              <th>{m.dimension}</th>
            </tr>
          </thead>
          <tbody>
            {request.stations.map((s, index) => (
              <tr key={index}>
                <td className="mono muted">{index + 1}</td>
                <td>
                  <strong>
                    {locale === "en-us"
                      ? s.englishName || s.chineseName
                      : s.chineseName}
                  </strong>
                  {s.englishName && (
                    <small>
                      {locale === "en-us" ? s.chineseName : s.englishName}
                    </small>
                  )}
                </td>
                <td className="mono">{s.x}</td>
                <td className="mono">{s.z}</td>
                <td>
                  <code>{s.dimension}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {request.notes && (
        <>
          <h3>{m.notes}</h3>
          <SafeMarkdown>{request.notes}</SafeMarkdown>
        </>
      )}
    </>
  );
}

function CloseIssueAction({
  number,
  onSuccess,
}: {
  number: number;
  onSuccess: () => void;
}) {
  const m = useMessages();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  async function closeIssue() {
    if (busy || receipt) return;
    setBusy(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    try {
      const response = await api<{ operation: { id: string } }>(
        `/api/issues/${number}/close`,
        {
          method: "POST",
          headers: { "Idempotency-Key": key.current },
          body: "{}",
        },
      );
      setReceipt(readReceipt(response));
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="issue-actions">
      {receipt ? (
        <OperationProgress receipt={receipt} onSuccess={onSuccess} />
      ) : (
        <button
          className="button button-secondary"
          disabled={busy}
          onClick={closeIssue}
        >
          {busy ? m.closingRequest : m.closeRequest}
        </button>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}

export function IssuePage({ number }: { number: number }) {
  const m = useMessages();
  const locale = useLocale();
  const auth = useAuth();
  const issueResult = useApi<{ issue: IssueDetail }>(`/api/issues/${number}`);
  const [page, setPage] = useState(1);
  const commentsResult = useApi<{
    comments: IssueComment[];
    page: number;
    hasMore: boolean;
  }>(issueResult.data ? `/api/issues/${number}/comments?page=${page}` : null);
  const issue = issueResult.data?.issue;
  return (
    <div className="container discussion-page">
      <Link className="back-link" href={localeHref(locale, "/#requests")}>
        <ArrowLeft size={15} />
        {m.requests}
      </Link>
      {/* Preserve the form during refreshes so a saved successful receipt does
          not remount, report success again, and trigger another refresh. */}
      {issueResult.loading && !issue ? (
        <Loading />
      ) : !issue ? (
        <EmptyState title={m.issueMissing} description={m.issueMissingBody}>
          <ErrorNotice error={issueResult.error} />
          <button
            className="button button-secondary"
            onClick={issueResult.refresh}
          >
            {m.retry}
          </button>
        </EmptyState>
      ) : (
        <>
          <div className="discussion-heading">
            <div className="issue-meta">
              <span
                className={`type-label ${issue.kind === "line-update" ? "line" : ""}`}
              >
                {issue.kind === "line-update"
                  ? m.lineUpdate
                  : issue.kind === "general"
                    ? m.general
                    : m.community}
              </span>
              <span className="mono">#{issue.number}</span>
              <StatusBadge status={issue.state} />
            </div>
            <h1>{issue.title}</h1>
            <div className="discussion-byline">
              <span className="avatar small">
                <UserRound size={15} />
              </span>
              <span>{issue.gameName || m.community}</span>
              <span className="muted">{m.anonymous}</span>
              <span className="dot-separator">·</span>
              <time dateTime={issue.createdAt}>
                {formatDate(issue.createdAt, locale)}
              </time>
            </div>
          </div>
          <article className="form-panel request-detail">
            <RequestContent issue={issue} />
            <div className="original-link">
              <ExternalAnchor href={issue.url}>{m.github}</ExternalAnchor>
            </div>
            {auth.user && issue.state === "open" && (
              <CloseIssueAction
                key={`${number}:${auth.user.id}`}
                number={number}
                onSuccess={() => {
                  issueResult.refresh();
                  commentsResult.refresh();
                }}
              />
            )}
            <ErrorNotice error={issueResult.error} />
          </article>
          <section className="discussion-comments">
            <div className="section-heading compact">
              <h2>
                {m.discussion}
                <span className="count-pill">{issue.commentsCount}</span>
              </h2>
            </div>
            {commentsResult.loading ? (
              <Loading />
            ) : commentsResult.error ? (
              <ErrorNotice error={commentsResult.error} />
            ) : commentsResult.data?.comments.length ? (
              <div className="comment-list">
                {commentsResult.data.comments.map((comment) => (
                  <article className="comment-card" key={comment.id}>
                    <div className="avatar">
                      {(comment.gameName || comment.author)
                        .slice(0, 1)
                        .toUpperCase()}
                    </div>
                    <div className="comment-content">
                      <header>
                        <strong>{comment.gameName || comment.author}</strong>
                        {comment.unverified && (
                          <span className="comment-unverified">
                            {m.anonymous}
                          </span>
                        )}
                        <time dateTime={comment.createdAt}>
                          {formatDate(comment.createdAt, locale)}
                        </time>
                      </header>
                      <SafeMarkdown>{comment.body}</SafeMarkdown>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<MessageCircle size={24} />}
                title={m.noComments}
                description={m.noCommentsBody}
              />
            )}
            {(page > 1 || commentsResult.data?.hasMore) && (
              <div className="pagination">
                <button
                  className="button button-secondary"
                  disabled={page === 1 || commentsResult.loading}
                  onClick={() => setPage((value) => value - 1)}
                >
                  {m.previous}
                </button>
                <span>
                  {m.page} {page}
                </span>
                <button
                  className="button button-secondary"
                  disabled={
                    !commentsResult.data?.hasMore || commentsResult.loading
                  }
                  onClick={() => setPage((value) => value + 1)}
                >
                  {m.next}
                </button>
              </div>
            )}
          </section>
          {issue.state === "open" && !issue.locked ? (
            <CommentForm
              issueNumber={number}
              onSuccess={() => {
                issueResult.refresh();
                commentsResult.refresh();
              }}
            />
          ) : (
            <Notice>
              <LockKeyhole size={15} />
              {m.readonly}
            </Notice>
          )}
        </>
      )}
    </div>
  );
}
