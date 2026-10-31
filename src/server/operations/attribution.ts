import type { Operation } from "./store";

/** Persist submission-time trust: promotion never verifies an earlier subscriber comment. */
export function verifiedAuthor(
  op: Pick<Operation, "actor_id" | "checkpoint">,
): boolean {
  const role = op.checkpoint.authorRole;
  // Before public subscriber registration, all authenticated authors were collaborators.
  return (
    (!!op.actor_id || op.checkpoint.accountDeleted === true) &&
    (role === undefined || role === "collaborator" || role === "admin")
  );
}
