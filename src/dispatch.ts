import type { WorkerBinding } from "./state.ts";
import type { CriterionSupport } from "./evaluator.ts";
import { SUPERVISION_BOUNDS } from "./evaluator.ts";

export interface DispatchIntent {
  id: string;
  taskID: string;
  workerID: string;
  identity: string;
  text: string;
  nonprogress: number;
  status: "reserved" | "admitted" | "ambiguous";
}
export type SupervisionResult = {
  status: "held" | "deferred" | "continued" | "complete" | "reconciled";
  reason: string;
};
export interface DispatchPort {
  unresolved(taskID: string): Promise<DispatchIntent | undefined>;
  // Serialize, validate current binding/authority and finite limits, consume the
  // reservation and persist the intent together before returning true.
  reserve(
    binding: WorkerBinding,
    intent: DispatchIntent,
    fence?: () => string | undefined,
  ): Promise<boolean>;
  delivery(intent: DispatchIntent): Promise<"admitted" | "absent" | "unknown">;
  // Native full-client prompt admission only, using exactly intent.id. Never use
  // a permission/form reply API or retry on a failed acknowledgement.
  admit(
    binding: WorkerBinding,
    intent: DispatchIntent,
    fence?: () => string | undefined,
  ): Promise<"admitted" | "ambiguous">;
  finish(
    intent: DispatchIntent,
    status: "admitted" | "ambiguous",
  ): Promise<void>;
  // Reject stale binding epochs/revisions; never overwrite takeover or completion.
  record(
    binding: WorkerBinding,
    result: SupervisionResult,
    support?: readonly CriterionSupport[],
    fence?: () => string | undefined,
  ): Promise<void>;
  nextPromptID(): string;
}

export async function reconcileIntent(
  binding: WorkerBinding,
  intent: DispatchIntent,
  port: DispatchPort,
): Promise<SupervisionResult> {
  let admitted = false;
  try {
    admitted =
      intent.taskID === binding.id &&
      intent.workerID === binding.workerID &&
      (await port.delivery(intent)) === "admitted";
  } catch {
    /* Unreadable history is not proof of absence. */
  }
  await port.finish(intent, admitted ? "admitted" : "ambiguous");
  const result: SupervisionResult = admitted
    ? {
        status: "reconciled",
        reason: "Existing delivery reconciled; no duplicate sent",
      }
    : {
        status: "held",
        reason: "Ambiguous delivery requires human reconciliation",
      };
  await port.record(binding, result);
  return result;
}

export function followupText(binding: WorkerBinding, nextStep: string): string {
  return [
    "This automatic task follow-up does not grant consent, answer permission or form requests, override a hold, or expand scope. Stop for human approval if any such request arises.",
    `Approved task: ${binding.goal}`,
    `Scope: ${JSON.stringify(binding.scope)}`,
    `Constraints: ${JSON.stringify(binding.constraints)}`,
    `Next step: ${nextStep}`,
  ].join("\n");
}

export interface AdmissionGuard {
  current(): Promise<string | undefined>;
  fence(): string | undefined;
  afterAdmission(): Promise<string | undefined>;
}
export async function dispatchFollowup(
  binding: WorkerBinding,
  intent: DispatchIntent,
  port: DispatchPort,
  guard: AdmissionGuard,
): Promise<SupervisionResult> {
  const record = async (reason: string): Promise<SupervisionResult> => {
    const result: SupervisionResult = { status: "held", reason };
    await port.record(binding, result);
    return result;
  };
  if (
    !intent.id.trim() ||
    intent.id.length > SUPERVISION_BOUNDS.promptIDChars ||
    intent.text.length > SUPERVISION_BOUNDS.promptChars
  ) {
    return record("Invalid bounded delivery intent");
  }
  let reason = await guard.current();
  if (reason) return record(reason);
  if (!(await port.reserve(binding, intent, guard.fence)))
    return record("Reservation rejected by current authority or finite limit");
  // Reservation is consumed even when the observer closes before admission.
  try {
    reason = await guard.current();
    reason ??= guard.fence();
  } catch {
    reason =
      "Unreadable post-reservation authority; ambiguous delivery requires human reconciliation";
  }
  if (reason) {
    await port.finish(intent, "ambiguous");
    return record(reason);
  }
  let outcome: "admitted" | "ambiguous" = "ambiguous";
  try {
    outcome =
      (await port.admit(binding, intent, guard.fence)) === "admitted"
        ? "admitted"
        : "ambiguous";
  } catch {
    /* A failed acknowledgement may follow a successful send. */
  }
  await port.finish(intent, outcome);
  reason = await guard.afterAdmission();
  if (reason) return record(reason);
  if (outcome !== "admitted")
    return record("Ambiguous delivery requires human reconciliation");
  const result: SupervisionResult = {
    status: "continued",
    reason: "In-scope follow-up admitted",
  };
  await port.record(binding, result);
  return result;
}
