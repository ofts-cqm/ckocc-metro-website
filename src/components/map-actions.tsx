"use client";

import { useEffect, useRef, useState } from "react";
import type {
  MapCheckState,
  MapUpdateReview,
  UpdateSummary,
} from "@/lib/contracts";
import {
  api,
  ApiError,
  ErrorNotice,
  Notice,
  OperationProgress,
  readReceipt,
  useMessages,
  type Receipt,
} from "./ui";

export function MapActions({
  update,
  onSuccess,
  active = true,
}: {
  update: UpdateSummary;
  active?: boolean;
  onSuccess: () => void;
}) {
  const m = useMessages();
  const [review, setReview] = useState<MapUpdateReview | null>(null);
  const [action, setAction] = useState<"merge" | "rollback" | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const reviewGeneration = useRef(0);
  const [error, setError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const inFlight = useRef(false);
  const key = useRef<string | null>(null);
  const merged = ["merged", "published"].includes(update.status);
  async function refreshReview() {
    if (inFlight.current) return;
    const generation = reviewGeneration.current;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const value = await api<{ review: MapUpdateReview }>(
        `/api/admin/updates/${update.id}`,
      );
      if (generation === reviewGeneration.current) {
        setReview(value.review);
        setError(null);
      }
    } catch (e) {
      if (generation === reviewGeneration.current) {
        setError(e);
        setReview(
          (previous) =>
            previous && {
              ...previous,
              canMerge: false,
              validation: {
                state: "unavailable",
                checkedAt: new Date().toISOString(),
                runs: [],
              },
            },
        );
      }
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }
  const reviewingMerge =
    active && action === "merge" && Boolean(review) && !receipt;
  useEffect(() => {
    if (!reviewingMerge) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshReview();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [reviewingMerge, update.id]);
  async function prepare(next: "merge" | "rollback") {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setReview(null);
    setReceipt(null);
    reviewGeneration.current++;
    setAction(next);
    key.current = null;
    try {
      const value = await api<{ review: MapUpdateReview }>(
        `/api/admin/updates/${update.id}`,
      );
      setReview(value.review);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  async function confirm() {
    if (!review || !action || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    try {
      const result = await api<{ operation: { id: string } }>(
        `/api/admin/updates/${update.id}/${action}`,
        {
          method: "POST",
          headers: { "Idempotency-Key": key.current },
          body: JSON.stringify({
            baseCommit: review.baseCommit,
            ...(action === "merge" ? { headSha: review.headSha } : {}),
          }),
        },
      );
      setReceipt(readReceipt(result));
      setReview(null);
    } catch (e) {
      setError(e);
      // A definitive rejection needs a fresh review. A lost response retains the key.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500)
        setReview(null);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  return (
    <div className="map-admin-actions">
      {!receipt && (
        <button
          className="button button-secondary"
          disabled={busy || refreshing}
          onClick={() => prepare(merged ? "rollback" : "merge")}
        >
          {busy ? m.loading : merged ? m.createRollbackPr : m.mergePr}
        </button>
      )}
      {review && (
        <div className="map-action-review">
          <strong>
            {m.reviewMapAction} #{review.prNumber}
          </strong>
          <p>
            {action === "rollback" ? m.restoreMapVersion : m.submittedMapSha}
          </p>
          <code className="full-hash">
            {action === "rollback"
              ? review.restoreRevision
              : review.mapRevision}
          </code>
          {action === "rollback" && (
            <Notice tone="warning">{m.rollbackWarning}</Notice>
          )}
          {action === "merge" && (
            <>
              <div
                className="map-check-widget"
                aria-label={m.requiredCheck}
                aria-busy={refreshing}
              >
                <div className="map-check-heading">
                  <div>
                    <strong>{m.requiredCheck}</strong>
                    <code>validate-map</code>
                  </div>
                  <button
                    className="button button-secondary"
                    disabled={busy || refreshing}
                    onClick={refreshReview}
                  >
                    {refreshing ? m.loading : m.refreshChecks}
                  </button>
                </div>
                <div role="status" aria-live="polite">
                  <span
                    className={`map-check-state check-${review.validation.state}`}
                  >
                    {
                      (
                        {
                          pending: m.checkPending,
                          running: m.checkRunning,
                          success: m.checkPassed,
                          failure: m.checkFailed,
                          cancelled: m.checkCancelled,
                          skipped: m.checkSkipped,
                          unavailable: m.checkUnavailable,
                        } satisfies Record<MapCheckState, string>
                      )[review.validation.state]
                    }
                  </span>
                  <p>
                    {review.validation.state === "success"
                      ? m.checkPassedHelp
                      : m.checkRequiredHelp}
                  </p>
                </div>
                {review.validation.runs.map(
                  (run, index) =>
                    run.title && (
                      <p
                        key={`${run.id}:${index}`}
                        className="map-check-detail"
                      >
                        {run.title}
                      </p>
                    ),
                )}
                <p className="field-hint">{m.checkAutoRefresh}</p>
              </div>
              <p>{m.mergeApproval}</p>
            </>
          )}
          {review.blockedReason && <ErrorNotice error={review.blockedReason} />}
          {((action === "merge" && review.canMerge) ||
            (action === "rollback" && review.canRollback)) && (
            <button
              className="button button-primary"
              disabled={busy || refreshing}
              onClick={confirm}
            >
              {busy
                ? m.loading
                : action === "rollback"
                  ? m.confirmRollback
                  : m.confirmMerge}
            </button>
          )}
          <button
            className="text-button"
            disabled={busy || refreshing}
            onClick={() => {
              reviewGeneration.current++;
              setReview(null);
              setAction(null);
            }}
          >
            {m.cancel}
          </button>
        </div>
      )}
      <ErrorNotice error={error} />
      {receipt && (
        <OperationProgress
          key={receipt.id}
          receipt={receipt}
          onSuccess={onSuccess}
        />
      )}
    </div>
  );
}
