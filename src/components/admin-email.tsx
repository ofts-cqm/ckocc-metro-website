"use client";

import { ErrorNotice, Loading, useApi, useLocale, formatDate } from "./ui";

const labels = {
  "en-us": {
    title: "Email delivery",
    empty: "No email jobs yet.",
    refresh: "Refresh",
    attempts: "Attempts",
    feedback: "Feedback",
    help: "Submitted means SES accepted the message. Unknown outcomes require review before any resend.",
  },
  "zh-cn": {
    title: "邮件发送",
    empty: "暂无邮件任务。",
    refresh: "刷新",
    attempts: "尝试次数",
    feedback: "反馈",
    help: "Submitted 表示 SES 已接受邮件。结果未知的任务须经人工核查后才能重发。",
  },
  "zh-hk": {
    title: "電郵傳送",
    empty: "暫無電郵工作。",
    refresh: "重新整理",
    attempts: "嘗試次數",
    feedback: "回饋",
    help: "Submitted 表示 SES 已接受電郵。結果未知的工作須經人工核查後才能重發。",
  },
};

type Job = {
  id: string;
  status: string;
  kind: string;
  attempts: number;
  errorCode: string | null;
  sesMessageId: string | null;
  updatedAt: string;
  feedback: string[];
};
export function AdminEmail() {
  const locale = useLocale();
  const m = labels[locale as keyof typeof labels] ?? labels["en-us"];
  const data = useApi<{
    jobs: Job[];
    feedback: { kind: string; count: number }[];
  }>("/api/admin/email");
  return (
    <section className="admin-operations">
      <div className="section-heading compact">
        <h2>{m.title}</h2>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void data.refresh()}
        >
          {m.refresh}
        </button>
      </div>
      <p>{m.help}</p>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorNotice error={data.error} />
      ) : (
        <>
          <p>
            {m.feedback}:{" "}
            {data.data?.feedback
              .map((item) => `${item.kind}: ${item.count}`)
              .join(" · ") || "—"}
          </p>
          {!data.data?.jobs.length ? (
            <p>{m.empty}</p>
          ) : (
            <div className="history-list">
              {data.data.jobs.map((job) => (
                <article key={job.id} className="history-item">
                  <div>
                    <strong className="mono">{job.id}</strong>
                    <p>
                      {job.kind} · {job.status} · {m.attempts}: {job.attempts}
                    </p>
                    <p>{formatDate(job.updatedAt, locale)}</p>
                    {job.errorCode && <code>{job.errorCode}</code>}
                    {job.sesMessageId && (
                      <p className="mono">SES: {job.sesMessageId}</p>
                    )}
                    {job.feedback.length > 0 && (
                      <p>{job.feedback.join(", ")}</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
