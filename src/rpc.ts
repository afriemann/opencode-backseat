import { Rpc } from "@opencode/plugin/rpc";
import type { EvaluationContext, TaskEvidence } from "./context.ts";
import type { Suggestion } from "./evaluator.ts";
import type { DecisionIdentity, StrictValidationResult } from "./evaluator.ts";
import type { WorkerSnapshot } from "./state.ts";
import type { SignedControl, ControlPayload } from "./ownership.ts";
import { fingerprint } from "./state.ts";
import {
  exact,
  integer,
  object,
  parseCoordinatorState,
  parseEvidence,
  parseWorkerSnapshot,
  text,
  type CoordinatorState,
  type TaskGoal,
} from "./state.ts";
import {
  parseDecisionIdentity,
  parseStrictValidationResult,
} from "./evaluator.ts";
import type { DispatchIntent, SupervisionResult } from "./dispatch.ts";
import type { SharedSnapshot } from "./context.ts";

export const CONTROL_OPERATIONS = [
  "create",
  "adopt",
  "hold",
  "resume",
  "takeover",
  "share",
  "reserve",
  "finish",
  "record",
  "detach",
] as const;
export type ControlOperation = (typeof CONTROL_OPERATIONS)[number];
export interface AttachInput {
  coordinatorID: string;
  verifier: string;
}
export interface AttachResult {
  generation: number;
}
export interface ControlInput {
  operation: ControlOperation;
  taskID: string;
  proof: SignedControl;
}
export interface SuggestInput {
  taskID: string;
  revision: number;
  epoch: number;
  evidence: TaskEvidence;
  generation: number;
  proof: SignedControl;
}
export interface SuggestResult {
  context?: EvaluationContext;
  suggestion?: Suggestion;
  reason?: string;
}
export interface ObserveInput {
  taskID: string;
  workerID: string;
}
export interface ObserveResult {
  snapshot?: WorkerSnapshot;
  reason?: string;
}
export interface ValidateInput {
  generation: number;
  identity: DecisionIdentity;
  evidence: TaskEvidence;
  suggestion: Suggestion;
  proof: SignedControl;
}
export interface ResumeReconciliation {
  generation: number;
  workerID: string;
  revision: number;
  epoch: number;
  snapshotFingerprint: string;
  observedAt: number;
  state: "settled";
  asks: readonly [];
}
// Explicit evidence tuples and recursively sorted unknown native values
// give both processes the same bytes without relying on object insertion order.
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object")
    return Object.keys(value)
      .sort()
      .map((key) => [key, normalized((value as Record<string, unknown>)[key])]);
  return value;
}
export function reasoningPayload(
  operation: "suggest",
  input: Omit<SuggestInput, "proof">,
): ControlPayload;
export function reasoningPayload(
  operation: "validate",
  input: Omit<ValidateInput, "proof">,
): ControlPayload;
export function reasoningPayload(
  operation: "suggest" | "validate",
  input: Omit<SuggestInput, "proof"> | Omit<ValidateInput, "proof">,
): ControlPayload {
  const evidence = [
    input.evidence.taskID,
    input.evidence.workerID,
    input.evidence.turn,
    input.evidence.entries.map((entry) => [
      entry.id,
      entry.kind,
      entry.text,
      entry.criterion ?? null,
      entry.native ? normalized(entry.native) : null,
      entry.native ? normalized(entry.input) : null,
      entry.native ? normalized(entry.result) : null,
    ]),
  ];
  const target =
    "identity" in input ? parseDecisionIdentity(input.identity) : input;
  return {
    operation,
    taskID: target.taskID,
    revision: target.revision,
    epoch: target.epoch,
    body: {
      fingerprint: fingerprint([
        operation,
        input.generation,
        normalized(evidence),
        "identity" in input
          ? normalized(input.identity)
          : [input.taskID, input.revision, input.epoch],
        "suggestion" in input ? normalized(input.suggestion) : null,
      ]),
    },
  };
}
function parseProof(value: unknown): SignedControl {
  const p = object(value);
  exact(p, ["generation", "sequence", "payload", "signature"]);
  return {
    generation: integer(p.generation, 1),
    sequence: integer(p.sequence, 1),
    payload: text(p.payload),
    signature: text(p.signature),
  };
}
export interface CoordinatorSnapshot extends CoordinatorState {
  home: string;
  authority: "owned" | "held" | "passive";
  reason?: string;
}
export interface ControlResult {
  snapshot: CoordinatorSnapshot;
  accepted: boolean;
}
export interface RecoverInput {
  coordinatorID: string;
}
export type ControlBody =
  | TaskGoal
  | { reconciliation: ResumeReconciliation }
  | { goal: TaskGoal; workerID: string }
  | {
      snapshot?: SharedSnapshot;
      shared: readonly { id: string; version: number }[];
    }
  | {
      intent: DispatchIntent;
      decisionAt: number;
      receiptID: string;
      identity: DecisionIdentity;
    }
  | { intentID: string; status: "admitted" | "ambiguous" }
  | {
      result: SupervisionResult;
      receiptID?: string;
      identity?: DecisionIdentity;
    }
  | Record<string, never>;

// Portable Standard Schema: validators are repository boundary parsers, not an
// Effect codec or a dependency on a schema library in the client process.
function schema<T>(parse: (value: unknown) => T): {
  "~standard": {
    version: 1;
    vendor: string;
    types?: { input: T; output: T };
    validate(value: unknown): { value: T } | { issues: { message: string }[] };
  };
} {
  return {
    "~standard": {
      version: 1,
      vendor: "conman",
      validate(value) {
        try {
          return { value: parse(value) };
        } catch {
          return { issues: [{ message: "Invalid conman boundary value" }] };
        }
      },
    },
  };
}
const empty = schema<Record<string, never>>((value) => {
  const v = object(value);
  exact(v, []);
  return {};
});
const attach = schema<AttachInput>((value) => {
  const v = object(value);
  exact(v, ["coordinatorID", "verifier"]);
  return { coordinatorID: text(v.coordinatorID), verifier: text(v.verifier) };
});
const recover = schema<RecoverInput>((value) => {
  const v = object(value);
  exact(v, ["coordinatorID"]);
  return { coordinatorID: text(v.coordinatorID) };
});
const control = schema<ControlInput>((value) => {
  const v = object(value);
  exact(v, ["operation", "taskID", "proof"]);
  if (!CONTROL_OPERATIONS.includes(v.operation as ControlOperation))
    throw new Error("Invalid operation");
  return {
    operation: v.operation as ControlOperation,
    taskID: text(v.taskID),
    proof: parseProof(v.proof),
  };
});
const suggest = schema<SuggestInput>((value) => {
  const v = object(value);
  exact(v, ["taskID", "revision", "epoch", "evidence", "generation", "proof"]);
  return {
    taskID: text(v.taskID),
    revision: integer(v.revision, 1),
    epoch: integer(v.epoch, 1),
    evidence: parseEvidence(v.evidence),
    generation: integer(v.generation, 1),
    proof: parseProof(v.proof),
  };
});
const snapshot = schema<CoordinatorSnapshot>((value) => {
  const v = object(value);
  const { home, authority, reason, ...state } = v;
  if (!["owned", "held", "passive"].includes(String(authority)))
    throw new Error("Invalid authority");
  return {
    ...parseCoordinatorState(state),
    home: text(home),
    authority: authority as CoordinatorSnapshot["authority"],
    ...(reason === undefined ? {} : { reason: text(reason) }),
  };
});
const suggestion = schema<SuggestResult>(
  (value) => object(value) as SuggestResult,
);
const observe = schema<ObserveInput>((value) => {
  const v = object(value);
  exact(v, ["taskID", "workerID"]);
  return { taskID: text(v.taskID), workerID: text(v.workerID) };
});
const observed = schema<ObserveResult>((value) => {
  const v = object(value);
  exact(v, ["snapshot", "reason"]);
  return {
    ...(v.snapshot === undefined
      ? {}
      : { snapshot: parseWorkerSnapshot(v.snapshot) }),
    ...(v.reason === undefined ? {} : { reason: text(v.reason) }),
  };
});
const validate = schema<ValidateInput>((value) => {
  const v = object(value);
  exact(v, ["generation", "identity", "evidence", "suggestion", "proof"]);
  if (JSON.stringify(v).length > 48_000)
    throw new Error("Oversized validation input");
  return {
    generation: integer(v.generation, 1),
    identity: parseDecisionIdentity(v.identity),
    evidence: parseEvidence(v.evidence),
    suggestion: object(v.suggestion) as unknown as Suggestion,
    proof: parseProof(v.proof),
  };
});
export const ConmanRpc = Rpc.define({
  id: "conman",
  methods: {
    inspect: { input: empty, output: snapshot },
    attach: {
      input: attach,
      output: schema<AttachResult>((value) => ({
        generation: integer(object(value).generation, 1),
      })),
    },
    control: {
      input: control,
      output: schema<ControlResult>((value) => {
        const v = object(value);
        if (typeof v.accepted !== "boolean") throw new Error("Invalid result");
        const parsed = snapshot["~standard"].validate(v.snapshot);
        if (!("value" in parsed)) throw new Error("Invalid snapshot");
        return { accepted: v.accepted, snapshot: parsed.value };
      }),
    },
    suggest: { input: suggest, output: suggestion },
    observe: { input: observe, output: observed },
    validate: {
      input: validate,
      output: schema<StrictValidationResult>(parseStrictValidationResult),
    },
    recover: { input: recover, output: snapshot },
  },
  events: {},
});
