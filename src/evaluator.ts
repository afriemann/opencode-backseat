import type { EvaluationContext } from "./context.ts";
export {
  AUTOMATION_LIMITS,
  VALIDATION_BOUNDS,
  parseNativeRef,
  parseDecisionIdentity,
  parseStrictValidationResult,
  parseValidationJudgment,
  validatedRelationships,
} from "./state.ts";

export interface NativeEvidenceRef {
  messageID: string;
  callID: string;
  state: "completed";
  inputFingerprint: string;
  resultFingerprint: string;
  inspectedContentFingerprint: string;
}
export interface DecisionIdentity {
  taskID: string;
  workerID: string;
  location: string;
  revision: number;
  epoch: number;
  generation: number;
  turn: number;
  nativeBoundary: string;
  snapshotIncarnation: string;
  snapshotSequence: number;
  snapshotInvalidationVersion: number;
  evidenceFingerprint: string;
  sharedVersions: readonly { id: string; version: number }[];
  suggestionFingerprint: string;
}
export interface ValidationRequest {
  identity: DecisionIdentity;
  suggestion: Suggestion;
}
export interface CriterionValidation {
  criterion: string;
  status: "accept" | "reject" | "unknown";
  rationale: string;
  evidence: readonly NativeEvidenceRef[];
}
export interface StrictValidationResult {
  receiptID: string;
  identity: DecisionIdentity;
  status: "accept" | "reject" | "unknown";
  rationale: string;
  criteria?: readonly CriterionValidation[];
}

export interface AutomationLimits {
  activeWorkers: number;
  followups: number;
  decisionAgeMs: number;
  nonprogress: number;
}
export const SUPERVISION_BOUNDS = {
  contextChars: 32_000,
  suggestionChars: 8_000,
  stepChars: 4_000,
  promptChars: 12_000,
  promptIDChars: 200,
} as const;
export interface CriterionSupport {
  criterion: string;
  evidenceID: string;
}
export type Suggestion =
  | {
      taskID: string;
      workerID: string;
      action: "continue" | "redirect";
      nextStep: string;
      scope: string[];
      progress: boolean;
    }
  | {
      taskID: string;
      workerID: string;
      action: "complete";
      support: CriterionSupport[];
    };
export interface EvaluatorPort {
  suggest(context: EvaluationContext): Promise<unknown>;
}
export async function evaluate(
  context: EvaluationContext,
  port: EvaluatorPort,
): Promise<Suggestion | undefined> {
  try {
    if (JSON.stringify(context).length > SUPERVISION_BOUNDS.contextChars)
      return undefined;
    const value: unknown = await port.suggest(structuredClone(context));
    if (
      !isObject(value) ||
      JSON.stringify(value).length > SUPERVISION_BOUNDS.suggestionChars ||
      value.taskID !== context.task.id ||
      value.workerID !== context.task.workerID
    )
      return undefined;
    if (value.action === "complete") {
      if (
        !onlyKeys(value, ["taskID", "workerID", "action", "support"]) ||
        !Array.isArray(value.support) ||
        !value.support.every(
          (entry) =>
            isObject(entry) &&
            onlyKeys(entry, ["criterion", "evidenceID"]) &&
            nonempty(entry.criterion) &&
            nonempty(entry.evidenceID),
        )
      )
        return undefined;
      return structuredClone(value) as Extract<
        Suggestion,
        { action: "complete" }
      >;
    }
    if (
      (value.action !== "continue" && value.action !== "redirect") ||
      !onlyKeys(value, [
        "taskID",
        "workerID",
        "action",
        "nextStep",
        "scope",
        "progress",
      ]) ||
      !nonempty(value.nextStep) ||
      value.nextStep.length > SUPERVISION_BOUNDS.stepChars ||
      typeof value.progress !== "boolean" ||
      !Array.isArray(value.scope) ||
      !value.scope.length ||
      !value.scope.every(
        (scope) => nonempty(scope) && context.task.scope.includes(scope),
      )
    )
      return undefined;
    return structuredClone(value) as Extract<Suggestion, { nextStep: string }>;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
