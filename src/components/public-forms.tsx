"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Lightbulb,
  MessageCircle,
  Plus,
  Route,
  Trash2,
} from "lucide-react";
import { languageTags, type MessageKey } from "@/lib/i18n";
import type { CommentPayload, LineType, RequestPayload } from "@/lib/contracts";
import { commentSchema, requestSchema } from "@/lib/schemas";
import { Turnstile } from "./turnstile";
import {
  api,
  ApiError,
  ErrorNotice,
  Field,
  localeHref,
  Notice,
  OperationProgress,
  PageIntro,
  randomToken,
  readReceipt,
  useDraft,
  useAuth,
  useLocale,
  useMessages,
  type Receipt,
} from "./ui";

const lineTypes: LineType[] = [
  "double-track-blue-ice",
  "single-track-blue-ice",
  "double-track-rail",
  "single-track-rail",
  "other",
];
export function lineTypeKey(value: LineType) {
  return value.replaceAll("-", "_") as MessageKey;
}
type StationDraft = {
  id: string;
  chineseName: string;
  englishName: string;
  x: string;
  z: string;
  dimension: string;
};
const station = (dimension = "overworld"): StationDraft => ({
  id:
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : "first",
  chineseName: "",
  englishName: "",
  x: "",
  z: "",
  dimension,
});
type RequestDraft = {
  kind: "general" | "line-update";
  gameName: string;
  comment: string;
  lineName: string;
  lineNumber: string;
  lineType: LineType;
  operation: "add" | "update";
  defaultDimension: string;
  stations: StationDraft[];
  notes: string;
};
const initialRequest: RequestDraft = {
  kind: "general",
  gameName: "",
  comment: "",
  lineName: "",
  lineNumber: "",
  lineType: "double-track-blue-ice",
  operation: "add",
  defaultDimension: "overworld",
  stations: [{ ...station(), id: "first" }],
  notes: "",
};
// A scoped anonymous receipt only grants access to its own submission status.
// Keep it separately from editable drafts so retries survive reloads and locale changes.
type PublicAttempt = {
  digest: string;
  key: string;
  token: string;
  payload: RequestPayload | CommentPayload;
  receipt?: Receipt;
};

export function RequestFormPage() {
  const m = useMessages();
  const locale = useLocale();
  const auth = useAuth();
  const [draft, setDraft, clearDraft, ready] = useDraft(
    "request-draft-v1",
    initialRequest,
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [challengeToken, setChallengeToken] = useState("");
  const [challengeVersion, setChallengeVersion] = useState(0);
  const [attempt, setAttempt, clearAttempt, attemptReady] =
    useDraft<PublicAttempt | null>("request-attempt-v1", null);
  const receipt = attempt?.receipt ?? null;
  const [done, setDone] = useState(false);
  const gameName = auth.user?.name ?? draft.gameName;
  const set = <K extends keyof RequestDraft>(key: K, value: RequestDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const setStation = (id: string, values: Partial<StationDraft>) =>
    setDraft((previous) => ({
      ...previous,
      stations: previous.stations.map((value) =>
        value.id === id ? { ...value, ...values } : value,
      ),
    }));
  function reorder(index: number, delta: number) {
    setDraft((previous) => {
      const stations = [...previous.stations];
      [stations[index], stations[index + delta]] = [
        stations[index + delta],
        stations[index],
      ];
      return { ...previous, stations };
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || receipt || auth.loading) return;
    setError(null);
    if (!challengeToken) {
      setError(new ApiError("CHALLENGE_REQUIRED"));
      return;
    }
    if (
      draft.kind === "line-update" &&
      draft.stations.some(
        (s) =>
          !s.x.trim() ||
          !s.z.trim() ||
          !/^[+-]?\d+$/.test(s.x.trim()) ||
          !/^[+-]?\d+$/.test(s.z.trim()) ||
          !Number.isSafeInteger(Number(s.x)) ||
          !Number.isSafeInteger(Number(s.z)),
      )
    ) {
      setError("INVALID_COORDINATE");
      return;
    }
    const raw =
      draft.kind === "general"
        ? {
            kind: draft.kind,
            gameName,
            locale: languageTags[locale],
            comment: draft.comment,
          }
        : {
            kind: draft.kind,
            gameName,
            locale: languageTags[locale],
            lineName: draft.lineName,
            lineNumber: draft.lineNumber,
            lineType: draft.lineType,
            operation: draft.operation,
            stations: draft.stations.map(({ id: _id, ...s }) => ({
              ...s,
              x: Number(s.x),
              z: Number(s.z),
            })),
            notes: draft.notes,
          };
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) {
      setError(new ApiError("VALIDATION_ERROR"));
      return;
    }
    const { locale: _payloadLocale, ...stablePayload } = parsed.data;
    const digest = JSON.stringify(stablePayload);
    const pending =
      attempt?.digest === digest
        ? attempt
        : {
            digest,
            key: crypto.randomUUID(),
            token: randomToken(),
            payload: parsed.data,
          };
    setAttempt(pending);
    setBusy(true);
    try {
      const response = await api<{
        operation?: { id: string };
        operationId?: string;
      }>("/api/requests", {
        method: "POST",
        headers: { "Idempotency-Key": pending.key },
        body: JSON.stringify({
          ...pending.payload,
          challengeToken,
          receiptToken: pending.token,
        }),
      });
      const value = readReceipt(response, pending.token);
      setAttempt({ ...pending, receipt: value });
    } catch (e) {
      setError(e);
      setChallengeToken("");
      setChallengeVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="container form-page">
      <Link className="back-link" href={localeHref(locale)}>
        <ArrowLeft size={15} />
        {m.map}
      </Link>
      <PageIntro
        eyebrow={m.boardEyebrow}
        title={m.requestTitle}
        description={m.requestIntro}
      />
      {receipt ? (
        <div className="form-panel success-panel">
          <CheckCircle2 size={38} />
          <h2>{done ? m.requestSuccess : m.submitted}</h2>
          <p>{done ? m.requestSuccessBody : m.submittedBody}</p>
          <OperationProgress
            receipt={receipt}
            onSuccess={() => {
              setDone(true);
              clearDraft();
            }}
          />
          {done && (
            <button
              className="button button-primary"
              onClick={() => {
                clearAttempt();
                setDone(false);
              }}
            >
              {m.anotherRequest}
              <ArrowRight size={16} />
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="request-form">
          <fieldset className="request-type-options" disabled={busy}>
            <legend>{m.requestType}</legend>
            {(["general", "line-update"] as const).map((value) => (
              <label
                key={value}
                className={`request-type-card ${draft.kind === value ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name="kind"
                  checked={draft.kind === value}
                  onChange={() => set("kind", value)}
                />
                <span className="request-type-icon">
                  {value === "general" ? (
                    <Lightbulb size={24} />
                  ) : (
                    <Route size={24} />
                  )}
                </span>
                <span>
                  <strong>
                    {value === "general" ? m.general : m.lineUpdate}
                  </strong>
                  <small>
                    {value === "general"
                      ? m.generalDescription
                      : m.lineDescription}
                  </small>
                </span>
                <span className="radio-decoration" />
              </label>
            ))}
          </fieldset>
          <fieldset
            className="form-panel"
            disabled={busy || !ready || !attemptReady || auth.loading}
          >
            <Field
              label={m.gameName}
              hint={auth.user ? m.accountGameNameHint : m.gameNameHint}
            >
              <input
                name="gameName"
                autoComplete="nickname"
                value={gameName}
                readOnly={!!auth.user}
                maxLength={64}
                required
                onChange={(e) => set("gameName", e.target.value)}
              />
            </Field>
            {draft.kind === "general" ? (
              <Field label={m.comment}>
                <textarea
                  name="comment"
                  rows={7}
                  placeholder={m.commentPlaceholder}
                  value={draft.comment}
                  maxLength={5000}
                  required
                  onChange={(e) => set("comment", e.target.value)}
                />
                <span className="character-count">
                  {Array.from(draft.comment).length} / 5,000
                </span>
              </Field>
            ) : (
              <>
                <div className="form-divider" />
                <div className="form-grid">
                  <Field label={m.lineName} optional>
                    <input
                      value={draft.lineName}
                      maxLength={120}
                      onChange={(e) => set("lineName", e.target.value)}
                    />
                  </Field>
                  <Field label={m.lineNumber} optional hint={m.lineNumberHint}>
                    <input
                      type="text"
                      value={draft.lineNumber}
                      maxLength={32}
                      onChange={(e) => set("lineNumber", e.target.value)}
                    />
                  </Field>
                  <Field label={m.lineType}>
                    <select
                      value={draft.lineType}
                      onChange={(e) =>
                        set("lineType", e.target.value as LineType)
                      }
                    >
                      {lineTypes.map((value) => (
                        <option key={value} value={value}>
                          {m[lineTypeKey(value)]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="field">
                    <span className="field-label">{m.operation}</span>
                    <div className="segmented operation-switch">
                      {(["add", "update"] as const).map((value) => (
                        <button
                          type="button"
                          key={value}
                          className={
                            draft.operation === value ? "selected" : ""
                          }
                          aria-pressed={draft.operation === value}
                          onClick={() => set("operation", value)}
                        >
                          {m[value]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="form-divider" />
                <div className="stations-heading">
                  <h2>{m.stationTitle}</h2>
                  <p>{m.stationHelp}</p>
                </div>
                <Field label={m.defaultDimension} hint={m.dimensionHint}>
                  <input
                    maxLength={128}
                    value={draft.defaultDimension}
                    onChange={(e) => set("defaultDimension", e.target.value)}
                    placeholder="overworld"
                  />
                </Field>
                <div className="station-list">
                  {draft.stations.map((value, index) => (
                    <section
                      className="station-row"
                      key={value.id}
                      aria-label={`${m.station} ${index + 1}`}
                    >
                      <div className="station-row-top">
                        <span className="station-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <strong>
                          {value.chineseName || `${m.station} ${index + 1}`}
                        </strong>
                        <div className="station-row-actions">
                          <button
                            type="button"
                            className="icon-button"
                            title={m.moveUp}
                            aria-label={`${m.moveUp}: ${index + 1}`}
                            disabled={index === 0}
                            onClick={() => reorder(index, -1)}
                          >
                            <ArrowUp size={16} />
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            title={m.moveDown}
                            aria-label={`${m.moveDown}: ${index + 1}`}
                            disabled={index === draft.stations.length - 1}
                            onClick={() => reorder(index, 1)}
                          >
                            <ArrowDown size={16} />
                          </button>
                          <button
                            type="button"
                            className="icon-button danger"
                            title={m.removeStation}
                            aria-label={`${m.removeStation}: ${index + 1}`}
                            disabled={draft.stations.length === 1}
                            onClick={() =>
                              set(
                                "stations",
                                draft.stations.filter((s) => s.id !== value.id),
                              )
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                      <div className="form-grid">
                        <Field label={m.chineseName}>
                          <input
                            required
                            value={value.chineseName}
                            maxLength={120}
                            onChange={(e) =>
                              setStation(value.id, {
                                chineseName: e.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field label={m.englishName} optional>
                          <input
                            value={value.englishName}
                            maxLength={120}
                            onChange={(e) =>
                              setStation(value.id, {
                                englishName: e.target.value,
                              })
                            }
                          />
                        </Field>
                      </div>
                      <div className="coordinate-grid">
                        <Field label={m.coordinateX}>
                          <input
                            inputMode="numeric"
                            required
                            pattern="[+\-]?[0-9]+"
                            value={value.x}
                            onChange={(e) =>
                              setStation(value.id, { x: e.target.value })
                            }
                            placeholder="0"
                          />
                        </Field>
                        <Field label={m.coordinateZ}>
                          <input
                            inputMode="numeric"
                            required
                            pattern="[+\-]?[0-9]+"
                            value={value.z}
                            onChange={(e) =>
                              setStation(value.id, { z: e.target.value })
                            }
                            placeholder="0"
                          />
                        </Field>
                        <Field label={m.dimension}>
                          <input
                            maxLength={128}
                            value={value.dimension}
                            placeholder="overworld"
                            onChange={(e) =>
                              setStation(value.id, {
                                dimension: e.target.value,
                              })
                            }
                          />
                        </Field>
                      </div>
                    </section>
                  ))}
                </div>
                <button
                  type="button"
                  className="button button-dashed"
                  disabled={draft.stations.length >= 200}
                  onClick={() =>
                    set("stations", [
                      ...draft.stations,
                      station(draft.defaultDimension.trim() || "overworld"),
                    ])
                  }
                >
                  <Plus size={17} />
                  {m.addStation}
                  <span className="muted">{draft.stations.length} / 200</span>
                </button>
                <Field label={m.notes} optional>
                  <textarea
                    rows={4}
                    value={draft.notes}
                    maxLength={5000}
                    placeholder={m.notesPlaceholder}
                    onChange={(e) => set("notes", e.target.value)}
                  />
                </Field>
              </>
            )}
            <Notice>{m.publicNotice}</Notice>
            <Turnstile key={challengeVersion} onVerify={setChallengeToken} />
            {error === "INVALID_COORDINATE" ? (
              <Notice tone="error">{m.coordinateError}</Notice>
            ) : (
              <ErrorNotice error={error} />
            )}
            <div className="form-actions">
              <span className="draft-note">{m.draftNotice}</span>
              <button
                className="button button-primary"
                type="submit"
                disabled={busy || !challengeToken}
              >
                {busy ? m.submitting : m.submit}
                <ArrowRight size={16} />
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}

export function CommentForm({
  issueNumber,
  onSuccess,
}: {
  issueNumber: number;
  onSuccess: () => void;
}) {
  const m = useMessages();
  const locale = useLocale();
  const [draft, setDraft, clearDraft] = useDraft(`comment-${issueNumber}`, {
    gameName: "",
    comment: "",
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [challengeToken, setChallengeToken] = useState("");
  const [challengeVersion, setChallengeVersion] = useState(0);
  const [attempt, setAttempt, clearAttempt, attemptReady] =
    useDraft<PublicAttempt | null>(`comment-attempt-${issueNumber}-v1`, null);
  const receipt = attempt?.receipt ?? null;
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || receipt) return;
    setError(null);
    const parsed = commentSchema.safeParse({
      ...draft,
      locale: languageTags[locale],
    });
    if (!parsed.success) {
      setError(new ApiError("VALIDATION_ERROR"));
      return;
    }
    if (!challengeToken) {
      setError(new ApiError("CHALLENGE_REQUIRED"));
      return;
    }
    const { locale: _payloadLocale, ...stablePayload } = parsed.data;
    const digest = JSON.stringify(stablePayload);
    const pending =
      attempt?.digest === digest
        ? attempt
        : {
            digest,
            key: crypto.randomUUID(),
            token: randomToken(),
            payload: parsed.data,
          };
    setAttempt(pending);
    setBusy(true);
    try {
      const response = await api<{
        operation?: { id: string };
        operationId?: string;
      }>(`/api/issues/${issueNumber}/comments`, {
        method: "POST",
        headers: { "Idempotency-Key": pending.key },
        body: JSON.stringify({
          ...pending.payload,
          challengeToken,
          receiptToken: pending.token,
        }),
      });
      const value = readReceipt(response, pending.token);
      setAttempt({ ...pending, receipt: value });
    } catch (e) {
      setError(e);
      setChallengeToken("");
      setChallengeVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="form-panel reply-panel">
      <div className="panel-heading">
        <MessageCircle size={22} />
        <div>
          <h2>{m.reply}</h2>
          <p>{m.replyIntro}</p>
        </div>
      </div>
      {receipt ? (
        <>
          <OperationProgress
            receipt={receipt}
            onSuccess={() => {
              clearDraft();
              setDone(true);
              onSuccess();
            }}
          />
          {done && (
            <>
              <Notice tone="success">{m.commentSuccess}</Notice>
              <button
                className="button button-secondary"
                onClick={() => {
                  clearAttempt();
                  setDone(false);
                }}
              >
                {m.reply}
                <Plus size={15} />
              </button>
            </>
          )}
        </>
      ) : (
        <form onSubmit={submit}>
          <fieldset disabled={busy || !attemptReady}>
            <Field label={m.gameName}>
              <input
                required
                maxLength={64}
                autoComplete="nickname"
                value={draft.gameName}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, gameName: e.target.value }))
                }
              />
            </Field>
            <Field label={m.comment}>
              <textarea
                required
                rows={5}
                maxLength={5000}
                value={draft.comment}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, comment: e.target.value }))
                }
              />
            </Field>
            <p className="field-hint">{m.publicNotice}</p>
            <Turnstile
              action="comment"
              key={challengeVersion}
              onVerify={setChallengeToken}
            />
            <ErrorNotice error={error} />
            <div className="form-actions">
              <span className="draft-note">{m.draftNotice}</span>
              <button
                type="submit"
                className="button button-primary"
                disabled={!challengeToken || busy}
              >
                {busy ? m.submitting : m.postComment}
                <ArrowRight size={16} />
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
