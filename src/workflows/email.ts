import { sleep } from "workflow";

/** Runs one persisted email job inside a durable workflow step.
 * The email workflow invokes it after a job is queued for delivery. */
async function executeStep(jobId: string) {
  "use step";
  const { executeEmailJob } = await import("@/server/email/jobs");
  return executeEmailJob(jobId);
}

/** Retries a queued email job using the delay returned by the job runner.
 * Email dispatch starts this workflow after recording the job in storage. */
export async function emailWorkflow(jobId: string) {
  "use workflow";
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await executeStep(jobId);
    if (!result.retry) return;
    await sleep(`${result.delay}s`);
  }
}
