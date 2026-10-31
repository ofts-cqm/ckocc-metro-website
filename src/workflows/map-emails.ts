import { sleep } from "workflow";

async function drainStep() {
  "use step";
  const { drainPublicationEmailPage } = await import("@/server/email/jobs");
  return drainPublicationEmailPage();
}

/** Each durable step advances bounded recipient/launch pages. Database intent
 * survives a failed workflow start; reconciliation starts another drain. */
export async function mapEmailWorkflow() {
  "use workflow";
  while (true) {
    const result = await drainStep();
    if (!result.remaining) return;
    await sleep(result.progress ? "1s" : "1m");
  }
}
