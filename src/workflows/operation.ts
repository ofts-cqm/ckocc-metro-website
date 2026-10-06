import { sleep } from "workflow";

async function executeStep(operationId: string) {
  "use step";
  // Only IDs/results reach the workflow log. Credentials and uploaded bytes stay inside this step.
  const { executeOperation } = await import("@/server/operations/worker");
  return executeOperation(operationId);
}

export async function operationWorkflow(operationId: string) {
  "use workflow";
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await executeStep(operationId);
    if (!result.retry) return;
    await sleep(`${result.delay}s`);
  }
}
