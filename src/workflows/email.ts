import { sleep } from "workflow";

async function executeStep(jobId: string) {
  "use step";
  const { executeEmailJob } = await import("@/server/email/jobs");
  return executeEmailJob(jobId);
}

export async function emailWorkflow(jobId: string) {
  "use workflow";
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await executeStep(jobId);
    if (!result.retry) return;
    await sleep(`${result.delay}s`);
  }
}
