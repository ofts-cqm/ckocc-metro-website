"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  GitPullRequest,
  Lightbulb,
  MessageCircle,
  Route,
  TrainFront,
} from "lucide-react";
import type { IssueSummary, PublishedMap } from "@/lib/contracts";
import { MapViewer } from "./map-viewer";
import {
  EmptyState,
  formatDate,
  Loading,
  localeHref,
  Notice,
  StatusBadge,
  useApi,
  useLocale,
  useMessages,
} from "./ui";

export function IssueCard({ issue }: { issue: IssueSummary }) {
  const m = useMessages();
  const locale = useLocale();
  return (
    <Link
      className="issue-card"
      href={localeHref(locale, `/issues/${issue.number}`)}
    >
      <div
        className={`issue-icon ${issue.kind === "line-update" ? "line" : ""}`}
      >
        {issue.kind === "line-update" ? (
          <Route size={20} />
        ) : (
          <Lightbulb size={20} />
        )}
      </div>
      <div className="issue-card-content">
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
          {issue.state === "closed" && <StatusBadge status="closed" />}
        </div>
        <h3>{issue.title}</h3>
        <div className="issue-bottom">
          <span>
            {issue.gameName || m.community}
            <span className="dot-separator">·</span>
            {formatDate(issue.createdAt, locale)}
          </span>
          <span>
            <MessageCircle size={13} />
            {new Intl.NumberFormat(locale).format(issue.commentsCount)}
            <span className="sr-only"> {m.comments}</span>
          </span>
        </div>
      </div>
      <ArrowUpRight className="issue-arrow" size={19} />
    </Link>
  );
}

export function RequestBoard() {
  const m = useMessages();
  const locale = useLocale();
  const [state, setState] = useState("open");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState(1);
  const result = useApi<{
    issues: IssueSummary[];
    page: number;
    hasMore: boolean;
  }>(
    `/api/issues?state=${state}${kind === "all" ? "" : `&kind=${kind}`}&page=${page}`,
  );
  return (
    <section id="requests" className="request-board">
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            <span />
            {m.boardEyebrow}
          </span>
          <h2>{m.boardTitle}</h2>
          <p>{m.boardBody}</p>
        </div>
        <Link className="text-link" href={localeHref(locale, "/requests/new")}>
          {m.submitRequest}
          <ArrowRight size={16} />
        </Link>
      </div>
      <div className="board-toolbar">
        <div className="segmented small" aria-label={m.filter}>
          {(["open", "closed"] as const).map((value) => (
            <button
              key={value}
              className={state === value ? "selected" : ""}
              aria-pressed={state === value}
              onClick={() => {
                setState(value);
                setPage(1);
              }}
            >
              {m[value]}
            </button>
          ))}
        </div>
        <select
          aria-label={m.requestType}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">{m.all}</option>
          <option value="general">{m.general}</option>
          <option value="line-update">{m.lineUpdate}</option>
        </select>
      </div>
      {result.loading ? (
        <Loading />
      ) : result.error ? (
        <div className="board-empty">
          <EmptyState
            icon={<MessageCircle size={25} />}
            title={m.requestUnavailable}
          >
            <button
              className="button button-secondary"
              onClick={result.refresh}
            >
              {m.retry}
            </button>
          </EmptyState>
        </div>
      ) : result.data?.issues.length ? (
        <div className="issue-list">
          {result.data.issues.map((issue) => (
            <IssueCard key={issue.number} issue={issue} />
          ))}
        </div>
      ) : (
        <div className="board-empty">
          <EmptyState
            icon={<MessageCircle size={25} />}
            title={
              kind === "all" && state === "open" ? m.requestEmpty : m.noMatching
            }
            description={
              kind === "all" && state === "open"
                ? m.requestEmptyBody
                : undefined
            }
          >
            <Link
              className="button button-secondary"
              href={localeHref(locale, "/requests/new")}
            >
              {m.submitRequest}
              <ArrowRight size={15} />
            </Link>
          </EmptyState>
        </div>
      )}
      {(page > 1 || result.data?.hasMore) && (
        <div className="pagination">
          <button
            className="button button-secondary"
            disabled={page === 1 || result.loading}
            onClick={() => setPage((p) => p - 1)}
          >
            {m.previous}
          </button>
          <span>
            {m.page} {page}
          </span>
          <button
            className="button button-secondary"
            disabled={!result.data?.hasMore || result.loading}
            onClick={() => setPage((p) => p + 1)}
          >
            {m.next}
          </button>
        </div>
      )}
    </section>
  );
}

export function HomePage() {
  const m = useMessages();
  const locale = useLocale();
  const result = useApi<{
    map: PublishedMap | null;
    source?: "bootstrap";
  }>("/api/map");
  const [bootstrap, setBootstrap] = useState<PublishedMap | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/maps/bootstrap.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((value) => {
        if (alive && value) setBootstrap(value.map ?? value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const map = result.data?.map ?? (result.error ? bootstrap : null);
  const snapshot = Boolean(
    result.data?.source === "bootstrap" ||
    (!result.data?.map && result.error && bootstrap),
  );
  return (
    <div className="container home-page">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span />
            {m.eyebrow}
          </span>
          <h1>{m.heroTitle}</h1>
          <p>{m.heroBody}</p>
          <div className="hero-actions">
            <Link
              className="button button-primary"
              href={localeHref(locale, "/requests/new")}
            >
              <MessageCircle size={17} />
              {m.submitRequest}
              <ArrowUpRight size={16} />
            </Link>
            <Link
              className="button button-secondary"
              href={localeHref(locale, "/updates")}
            >
              <GitPullRequest size={17} />
              {m.submitUpdate}
            </Link>
          </div>
        </div>
        <div className="hero-rail-art" aria-hidden="true">
          <svg viewBox="0 0 350 190" fill="none">
            <path
              d="M20 148H97C130 148 118 55 157 55H330"
              stroke="#d99b32"
              strokeWidth="10"
            />
            <path
              d="M20 47H87C120 47 120 108 155 108H330"
              stroke="#296f64"
              strokeWidth="10"
            />
            <path
              d="M20 96H65C112 96 120 157 168 157H330"
              stroke="#c66d64"
              strokeWidth="10"
            />
            {[
              [50, 47],
              [187, 55],
              [294, 55],
              [78, 97],
              [208, 108],
              [294, 108],
              [50, 148],
              [208, 157],
              [294, 157],
            ].map(([x, y], i) => (
              <circle
                key={i}
                cx={x}
                cy={y}
                r="6"
                fill="#faf9f6"
                stroke="#243c38"
                strokeWidth="2.5"
              />
            ))}
            <rect
              x="126"
              y="83"
              width="20"
              height="40"
              rx="10"
              transform="rotate(-22 126 83)"
              fill="#faf9f6"
              stroke="#243c38"
              strokeWidth="3"
            />
          </svg>
          <span>{m.brandSub}</span>
        </div>
      </section>
      {map ? (
        <MapViewer map={map} snapshot={snapshot} />
      ) : result.loading ? (
        <div className="map-placeholder">
          <Loading />
        </div>
      ) : (
        <div className="map-placeholder">
          <EmptyState
            icon={<TrainFront size={34} />}
            title={m.mapEmpty}
            description={result.error ? m.mapUnavailable : m.mapEmptyBody}
          />
        </div>
      )}
      <div className="below-map">
        <span>{snapshot ? m.referenceNotice : m.mapCaption}</span>
        <a href="#requests">
          {m.requests}
          <ArrowDown size={14} />
        </a>
      </div>
      <RequestBoard />
      <section className="contributor-banner">
        <div className="banner-icon">
          <GitPullRequest size={26} />
        </div>
        <div>
          <h2>{m.submitUpdate}</h2>
          <p>{m.updatesIntro}</p>
        </div>
        <Link
          className="button button-dark"
          href={localeHref(locale, "/updates")}
        >
          {m.startUpdate}
          <ArrowRight size={16} />
        </Link>
      </section>
    </div>
  );
}
