import { Rpc } from "@opencode/plugin/rpc";
import type { EvaluationContext, TaskEvidence } from "./context.ts";
import type { DecisionIdentity, Suggestion } from "./evaluator.ts";
import { exact, object, text, type CoordinatorState } from "./state.ts";

export const CONTROL_OPERATIONS = [
  "create",
  "adopt",
  "dispatch",
  "hold",
  "resume",
  "takeover",
  "share",
  "reserve",
  "finish",
  "record",
] as const;
export type ControlOperation = (typeof CONTROL_OPERATIONS)[number];
export interface SuggestInput {
  taskID: string;
  revision: number;
  epoch: number;
  evidence: TaskEvidence;
  generation: number;
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
  snapshot?: import("./state.ts").WorkerSnapshot;
  reason?: string;
}
export interface ValidateInput {
  generation: number;
  identity: DecisionIdentity;
  evidence: TaskEvidence;
  suggestion: Suggestion;
}
export interface CoordinatorSnapshot extends CoordinatorState {
  dataDir: string;
  authority: "owned" | "held";
  reason?: string;
}
export interface CoordinatorBootstrap {
  dataDir?: string;
  authority: "owned" | "held";
  reason?: string;
}
export interface ControlResult {
  snapshot?: CoordinatorSnapshot;
  accepted: boolean;
  reason?: string;
}
export interface RecoverInput {
  coordinatorID: string;
}

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
      vendor: "backseat",
      validate(value) {
        try {
          return { value: parse(value) };
        } catch {
          return { issues: [{ message: "Invalid backseat boundary value" }] };
        }
      },
    },
  };
}
export const BackseatRpc = Rpc.define({
  id: "backseat",
  methods: {
    identity: {
      input: schema<{ nonce: string; origin: string }>((value) => {
        const v = object(value);
        exact(v, ["nonce", "origin"]);
        const nonce = text(v.nonce),
          origin = text(v.origin);
        if (!/^[a-f0-9]{64}$/.test(nonce) || origin.length > 200)
          throw new Error("Invalid native identity challenge");
        return { nonce, origin };
      }),
      output: schema<{ mac: string }>((value) => {
        const v = object(value);
        exact(v, ["mac"]);
        const mac = text(v.mac);
        if (!/^[a-f0-9]{64}$/.test(mac))
          throw new Error("Invalid native identity proof");
        return { mac };
      }),
    },
    bootstrap: {
      input: schema<Record<string, never>>((value) => {
        exact(object(value), []);
        return {};
      }),
      output: schema<CoordinatorBootstrap>((value) => {
        const v = object(value);
        exact(v, ["dataDir", "authority", "reason"]);
        if (v.authority !== "owned" && v.authority !== "held")
          throw new Error("Invalid bootstrap authority");
        if (
          v.dataDir === undefined &&
          (v.authority !== "held" || v.reason === undefined)
        )
          throw new Error("Unavailable store requires a held reason");
        return {
          ...(v.dataDir === undefined ? {} : { dataDir: text(v.dataDir) }),
          authority: v.authority,
          ...(v.reason === undefined ? {} : { reason: text(v.reason) }),
        };
      }),
    },
  },
  events: {},
});
