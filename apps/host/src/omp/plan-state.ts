import { createHash } from "node:crypto";
import { parseSessionPlan, type SessionPlan } from "../../../../packages/shared/src/session-plan";
import type { NativePlanSnapshot, NativePlanReview } from "./plan-controller";

/** Pure projection of the captured native owner. Reading UI state never enters
 * plan mode, reads a client-selected path, or opens a dismissed review. */
export function projectSessionPlan(input: {
  epoch: string;
  snapshot: NativePlanSnapshot;
  review?: NativePlanReview;
  enabled: boolean;
  busyReason?: string;
}): SessionPlan {
  const { snapshot, review } = input;
  if (Boolean(snapshot.review) !== Boolean(review) || snapshot.review && review
    && (snapshot.review.id !== review.id || snapshot.review.revision !== review.revision
      || snapshot.review.documentRevision !== review.document.documentRevision))
    throw new Error("The native Plan review changed while reading its owner.");
  const projected = review ? {
    id: review.id, revision: review.revision, title: review.title,
    reference: review.reference, content: review.content,
    status: snapshot.reconciliationRequired ? "unknown" : review.status === "open" ? "ready" : review.status === "awaiting-admission" ? "deciding" : "dismissed",
    canKeepContext: review.canKeepContext,
    ...(review.keepContextReason ? { keepContextReason: review.keepContextReason } : {}),
    document: structuredClone(review.document),
  } : null;
  const body = {
    mode: snapshot.mode, enabled: input.enabled,
    canToggle: input.enabled && snapshot.canToggle && !snapshot.busy && !input.busyReason && projected?.status !== "deciding",
    ...(input.busyReason ? { busyReason: input.busyReason } : {}),
    ...(snapshot.warning ? { warning: snapshot.warning } : {}),
    review: projected, executionChoices: snapshot.executionChoices,
    ...(snapshot.defaultExecutionRole ? { defaultExecutionRole: snapshot.defaultExecutionRole } : {}),
    ...(snapshot.reconciliationRequired ? { reconciliationRequired: true } : {}),
  };
  // Include native state affecting admission, not just the visible artifact.
  // Reopening another worker necessarily changes the epoch even if all content
  // and native identity bytes are otherwise equal.
  const revision = createHash("sha256").update(JSON.stringify({ body, snapshot })).digest("hex");
  return parseSessionPlan({ ticket: { epoch: input.epoch, nativeSessionId: snapshot.nativeSessionId, revision }, ...body });
}
