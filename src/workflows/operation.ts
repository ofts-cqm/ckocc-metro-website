import { sleep } from "workflow";

/** Runs one persisted operation attempt inside a durable workflow step.
 * The operation queue invokes it after accepting a user or admin action. */
async function executeStep(operationId: string) {
  "use step";
  // Only IDs/results reach the workflow log. Credentials and uploaded bytes stay inside this step.
  const { executeOperation } = await import("@/server/operations/worker");
  return executeOperation(operationId);
}

/** Schedules bounded retries for an operation using the worker's delay.
 * The API and outbox start this workflow after recording the operation. */
export async function operationWorkflow(operationId: string) {
  "use workflow";
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await executeStep(operationId);
    if (!result.retry) return;
    await sleep(`${result.delay}s`);
  }
}
