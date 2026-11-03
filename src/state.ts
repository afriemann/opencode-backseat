import type {
  CriterionValidation,
  DecisionIdentity,
  NativeEvidenceRef,
  StrictValidationResult,
} from "./evaluator.ts";
import type { EvidenceEntry, EvaluationContext } from "./context.ts";
import { createHash } from "node:crypto";

export const AUTOMATION_LIMITS = {
  activeWorkers: 8,
  followups: 3,
  decisionAgeMs: 20 * 60 * 1000,
  nonprogress: 2,
} as const;

export const VALIDATION_BOUNDS = {
  resultChars: 8_000,
  rationaleChars: 1_000,
  receipts: 32,
  nativeRefs: 64,
  timeoutMs: 30_000,
} as const;
export const STATE_BOUNDS = {
  bindings: 200,
  snapshots: 200,
  intents: 800,
  completions: 200,
  bytes: 8 * 1024 * 1024,
} as const;
export function assertStateBounds(value: unknown): void {
  const v = object(value);
  for (const field of [
    "bindings",
    "snapshots",
    "intents",
    "completions",
  ] as const)
    if (!Array.isArray(v[field]) || v[field].length > STATE_BOUNDS[field])
      throw new Error("Durable inventory capacity exhausted");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > STATE_BOUNDS.bytes)
    throw new Error("Durable inventory byte capacity exhausted");
}
// These hashes correlate local input bytes; they never manufacture native provenance.
export function fingerprint(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Unfingerprintable evidence");
  return createHash("sha256").update(encoded).digest("hex");
}
export function nativeReferenceMatches(
  ref: NativeEvidenceRef,
  entry: EvidenceEntry,
): boolean {
  try {
    return (
      entry.kind === "tool" &&
      entry.id === ref.callID &&
      entry.native !== undefined &&
      fingerprint(ref) === fingerprint(entry.native) &&
      entry.native.state === "completed" &&
      ref.inputFingerprint === fingerprint(entry.input) &&
      ref.resultFingerprint === fingerprint(entry.result) &&
      ref.inspectedContentFingerprint === fingerprint(entry.text) &&
      entry.text ===
        JSON.stringify({ input: entry.input, result: entry.result })
    );
  } catch {
    return false;
  }
}
export function parseNativeRef(value: unknown): NativeEvidenceRef {
  const v = object(value);
  exact(v, [
    "messageID",
    "callID",
    "state",
    "inputFingerprint",
    "resultFingerprint",
    "inspectedContentFingerprint",
  ]);
  if (v.state !== "completed")
    throw new Error("Native evidence is not completed");
  return {
    messageID: text(v.messageID),
    callID: text(v.callID),
    state: "completed",
    inputFingerprint: digest(v.inputFingerprint),
    resultFingerprint: digest(v.resultFingerprint),
    inspectedContentFingerprint: digest(v.inspectedContentFingerprint),
  };
}
export function parseDecisionIdentity(value: unknown): DecisionIdentity {
  const v = object(value);
  exact(v, [
    "taskID",
    "workerID",
    "location",
    "revision",
    "epoch",
    "generation",
    "turn",
    "nativeBoundary",
    "snapshotIncarnation",
    "snapshotSequence",
    "snapshotInvalidationVersion",
    "evidenceFingerprint",
    "sharedVersions",
    "suggestionFingerprint",
  ]);
  return {
    taskID: text(v.taskID),
    workerID: text(v.workerID),
    location: text(v.location),
    revision: integer(v.revision, 1),
    epoch: integer(v.epoch, 1),
    generation: integer(v.generation, 1),
    turn: integer(v.turn),
    nativeBoundary: text(v.nativeBoundary),
    snapshotIncarnation: text(v.snapshotIncarnation),
    snapshotSequence: integer(v.snapshotSequence, 1),
    snapshotInvalidationVersion: integer(v.snapshotInvalidationVersion),
    evidenceFingerprint: digest(v.evidenceFingerprint),
    sharedVersions: list(v.sharedVersions, (entry) => {
      const r = object(entry);
      exact(r, ["id", "version"]);
      return { id: text(r.id), version: integer(r.version, 1) };
    }),
    suggestionFingerprint: digest(v.suggestionFingerprint),
  };
}
function digest(value: unknown): string {
  const s = text(value);
  if (!/^[a-f0-9]{64}$/.test(s))
    throw new Error("Invalid evidence fingerprint");
  return s;
}
function judgment(value: unknown): StrictValidationResult["status"] {
  if (value !== "accept" && value !== "reject" && value !== "unknown")
    throw new Error("Invalid validation status");
  return value;
}
function rationale(value: unknown): string {
  const s = text(value);
  if (s.length > VALIDATION_BOUNDS.rationaleChars)
    throw new Error("Oversized validation rationale");
  return s;
}
export function parseStrictValidationResult(
  value: unknown,
): StrictValidationResult {
  const v = object(value);
  exact(v, ["receiptID", "identity", "status", "rationale", "criteria"]);
  if (JSON.stringify(v).length > VALIDATION_BOUNDS.resultChars)
    throw new Error("Oversized validation result");
  return {
    receiptID: text(v.receiptID),
    identity: parseDecisionIdentity(v.identity),
    ...parseValidationJudgment({
      status: v.status,
      rationale: v.rationale,
      ...(v.criteria === undefined ? {} : { criteria: v.criteria }),
    }),
  };
}
export function parseValidationJudgment(
  value: unknown,
): Omit<StrictValidationResult, "receiptID" | "identity"> {
  const v = object(value);
  exact(v, ["status", "rationale", "criteria"]);
  if (JSON.stringify(v).length > VALIDATION_BOUNDS.resultChars)
    throw new Error("Oversized validation result");
  const criteria =
    v.criteria === undefined
      ? undefined
      : list(v.criteria, (entry): CriterionValidation => {
          const c = object(entry);
          exact(c, ["criterion", "status", "rationale", "evidence"]);
          const evidence = list(c.evidence, parseNativeRef);
          if (
            evidence.length > VALIDATION_BOUNDS.nativeRefs ||
            new Set(
              evidence.map((r) => JSON.stringify([r.messageID, r.callID])),
            ).size !== evidence.length
          )
            throw new Error("Invalid native relationships");
          return {
            criterion: text(c.criterion),
            status: judgment(c.status),
            rationale: rationale(c.rationale),
            evidence,
          };
        });
  return {
    status: judgment(v.status),
    rationale: rationale(v.rationale),
    ...(criteria === undefined ? {} : { criteria }),
  };
}
export function validatedRelationships(
  context: EvaluationContext,
  criteria: readonly CriterionValidation[],
): boolean {
  return (
    criteria.length === context.task.criteria.length &&
    context.task.criteria.every((criterion) => {
      const matches = criteria.filter((c) => c.criterion === criterion);
      return (
        matches.length === 1 &&
        matches[0]!.status === "accept" &&
        matches[0]!.evidence.length > 0 &&
        matches[0]!.evidence.every(
          (ref) =>
            context.evidence.filter((entry) =>
              nativeReferenceMatches(ref, entry),
            ).length === 1,
        )
      );
    })
  );
}

export interface TaskGoal {
  id: string;
  title: string;
  goal: string;
  criteria: readonly string[];
  constraints: readonly string[];
  scope: readonly string[];
  location: string;
  agent: string;
  group?: string;
  shared?: readonly { id: string; version: number }[];
}

export interface WorkerBinding extends TaskGoal {
  workerID: string;
  revision: number;
  epoch: number;
  status: "held" | "active" | "manual" | "complete";
  followups: number;
  nonprogress: number;
}

export interface WorkerSnapshot {
  dataDir: string;
  location: string;
  sessionID: string;
  incarnation: string;
  sequence: number;
  invalidationVersion: number;
  messageIDs: readonly string[];
  contextFingerprint: string;
  nativeBoundary: string;
  background: readonly WorkerBackground[];
  publishedAt: number;
}
// Structural projection of the installed 2.2.5 SessionIdleBackground contract.
export type WorkerBackground =
  | {
      readonly kind: "shell";
      readonly sessionID: string;
      readonly shellID: string;
      readonly command: string;
    }
  | {
      readonly kind: "subagent";
      readonly sessionID: string;
      readonly childSessionID: string;
      readonly agent: string;
      readonly description: string;
    }
  | {
      readonly kind: "image";
      readonly sessionID: string;
      readonly path: string;
      readonly model: string;
    };
export interface WorkerIdleEvent {
  readonly sessionID: string;
  readonly background: readonly WorkerBackground[];
}

export interface CreationHost {
  locationExists(location: string): Promise<boolean>;
  agentAvailable(location: string, agent: string): Promise<boolean>;
  approve(goal: TaskGoal): Promise<void>;
  create(input: {
    title: string;
    agent: string;
    location: { directory: string };
  }): Promise<{ id: string; agent?: string; location: { directory: string } }>;
  prompt(input: { sessionID: string; text: string }): Promise<unknown>;
  save(binding: WorkerBinding): Promise<void>;
}

export interface AdoptionHost {
  read(
    workerID: string,
  ): Promise<{ id: string; agent?: string; location: { directory: string } }>;
  bindingFor(workerID: string): Promise<WorkerBinding | undefined>;
  approve(goal: TaskGoal, workerID: string): Promise<void>;
  save(binding: WorkerBinding): Promise<void>;
}

export interface ResumeEligibility {
  workerID: string;
  revision: number;
  epoch: number;
  issues: readonly string[];
}

export function takeoverWorker(binding: WorkerBinding): WorkerBinding {
  return {
    ...structuredClone(binding),
    status: "manual",
    epoch: binding.epoch + 1,
  };
}

export function resumeWorker(
  binding: WorkerBinding,
  eligibility: ResumeEligibility,
): WorkerBinding {
  if (
    binding.status === "complete" ||
    eligibility.workerID !== binding.workerID ||
    eligibility.epoch !== binding.epoch ||
    eligibility.revision !== binding.revision ||
    eligibility.issues.length
  ) {
    throw new Error("Resume is not eligible");
  }
  return {
    ...structuredClone(binding),
    status: "active",
    epoch: binding.epoch + 1,
  };
}

function initialBinding(goal: TaskGoal, workerID: string): WorkerBinding {
  return {
    ...goal,
    workerID,
    revision: 1,
    epoch: 1,
    status: "held",
    followups: 0,
    nonprogress: 0,
  };
}

function assertTarget(
  worker: { id: string; agent?: string; location: { directory: string } },
  goal: TaskGoal,
  expectedID = worker.id,
): void {
  if (
    !worker.id.trim() ||
    worker.id !== expectedID ||
    worker.location.directory !== goal.location ||
    worker.agent !== goal.agent
  ) {
    throw new Error("Unavailable target: mismatched worker response");
  }
}

export async function adoptWorker(
  input: TaskGoal,
  workerID: string,
  host: AdoptionHost,
): Promise<WorkerBinding> {
  const goal = structuredClone(input);
  if (!isCompleteGoal(goal) || !workerID.trim())
    throw new Error("Unavailable target: incomplete task binding");
  if (await host.bindingFor(workerID)) throw new Error("Worker already owned");
  assertTarget(await host.read(workerID), goal, workerID);
  await host.approve(goal, workerID);
  if (await host.bindingFor(workerID)) throw new Error("Worker already owned");
  assertTarget(await host.read(workerID), goal, workerID);
  const binding = initialBinding(goal, workerID);
  await host.save(binding);
  return binding;
}

export function isCompleteGoal(goal: TaskGoal): boolean {
  const required = [goal.id, goal.title, goal.goal, goal.location, goal.agent];
  const nonempty = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0;
  return (
    required.every(nonempty) &&
    Array.isArray(goal.criteria) &&
    goal.criteria.length > 0 &&
    goal.criteria.every(nonempty) &&
    Array.isArray(goal.scope) &&
    goal.scope.length > 0 &&
    goal.scope.every(nonempty) &&
    Array.isArray(goal.constraints) &&
    goal.constraints.every(nonempty)
  );
}

export async function createWorker(
  input: TaskGoal,
  host: CreationHost,
): Promise<WorkerBinding> {
  const goal = structuredClone(input);
  if (!isCompleteGoal(goal)) {
    throw new Error("Unavailable target: incomplete task binding");
  }
  if (
    !(await host.locationExists(goal.location)) ||
    !(await host.agentAvailable(goal.location, goal.agent))
  ) {
    throw new Error("Unavailable target: location or agent");
  }
  await host.approve(goal);
  if (
    !(await host.locationExists(goal.location)) ||
    !(await host.agentAvailable(goal.location, goal.agent))
  ) {
    throw new Error(
      "Unavailable target: location or agent changed during approval",
    );
  }
  const worker = await host.create({
    title: goal.title,
    agent: goal.agent,
    location: { directory: goal.location },
  });
  assertTarget(worker, goal);
  const binding = initialBinding(goal, worker.id);
  await host.save(binding);
  await host.prompt({
    sessionID: worker.id,
    text: initialTaskText(goal),
  });
  return binding;
}
export function initialTaskText(goal: TaskGoal): string {
  return [
    "Work only on this explicitly approved task. This message does not answer permission, consent or scope-expansion requests.",
    `Task: ${goal.goal}`,
    `Success criteria: ${JSON.stringify(goal.criteria)}`,
    `Scope: ${JSON.stringify(goal.scope)}`,
    `Constraints: ${JSON.stringify(goal.constraints)}`,
  ].join("\n");
}

export interface StoredIntent {
  intent: import("./dispatch.ts").DispatchIntent;
  revision: number;
  epoch: number;
  generation: number;
  createdAt: number;
  kind?: "initial" | "manual";
  validation?: StrictValidationResult;
}
export interface CompletionRecord {
  taskID: string;
  workerID: string;
  revision: number;
  epoch: number;
  generation: number;
  support: readonly import("./evaluator.ts").CriterionSupport[];
  evidence: {
    taskID: string;
    workerID: string;
    turn: number;
    fingerprint: string;
    native: readonly NativeEvidenceRef[];
  };
  validation: import("./evaluator.ts").StrictValidationResult;
}
export interface CoordinatorState {
  version: 1;
  bindings: WorkerBinding[];
  snapshots: import("./context.ts").SharedSnapshot[];
  intents: StoredIntent[];
  completions: CompletionRecord[];
  observer?: import("./ownership.ts").ObserverRecord;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_000)
    throw new Error("Invalid bounded text");
  return value;
}
export function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new Error("Invalid counter");
  return value;
}
export function list<T>(value: unknown, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid list");
  return value.map(parse);
}
export function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unknown input field");
}
export function parseGoal(value: unknown): TaskGoal {
  const v = object(value);
  const goal: TaskGoal = {
    id: text(v.id),
    title: text(v.title),
    goal: text(v.goal),
    criteria: list(v.criteria, text),
    constraints: list(v.constraints, text),
    scope: list(v.scope, text),
    location: text(v.location),
    agent: text(v.agent),
    ...(v.group === undefined ? {} : { group: text(v.group) }),
    ...(v.shared === undefined
      ? {}
      : {
          shared: list(v.shared, (entry) => {
            const ref = object(entry);
            return { id: text(ref.id), version: integer(ref.version, 1) };
          }),
        }),
  };
  if (
    !isCompleteGoal(goal) ||
    JSON.stringify(goal).length > 8_000 ||
    new Set(goal.criteria).size !== goal.criteria.length
  )
    throw new Error("Incomplete or oversized task goal");
  return goal;
}
export function parseBinding(value: unknown): WorkerBinding {
  const v = object(value);
  if (!["held", "active", "manual", "complete"].includes(String(v.status)))
    throw new Error("Invalid task status");
  if (
    integer(v.followups) > AUTOMATION_LIMITS.followups ||
    integer(v.nonprogress) > AUTOMATION_LIMITS.nonprogress
  )
    throw new Error("Invalid durable allowance");
  return {
    ...parseGoal(v),
    workerID: text(v.workerID),
    revision: integer(v.revision, 1),
    epoch: integer(v.epoch, 1),
    status: v.status as WorkerBinding["status"],
    followups: integer(v.followups),
    nonprogress: integer(v.nonprogress),
  };
}
export function parseSnapshot(
  value: unknown,
): import("./context.ts").SharedSnapshot {
  const v = object(value);
  return {
    id: text(v.id),
    version: integer(v.version, 1),
    group: text(v.group),
    content: text(v.content),
    recipients: list(v.recipients, text),
  };
}
export function parseEvidence(
  value: unknown,
): import("./context.ts").TaskEvidence {
  const v = object(value);
  exact(v, ["taskID", "workerID", "turn", "entries"]);
  if (
    JSON.stringify(v).length > 32_000 ||
    !Array.isArray(v.entries) ||
    v.entries.length > 200
  )
    throw new Error("Oversized evidence");
  return {
    taskID: text(v.taskID),
    workerID: text(v.workerID),
    turn: integer(v.turn),
    entries: list(v.entries, (entry) => {
      const e = object(entry);
      exact(e, [
        "id",
        "kind",
        "text",
        "criterion",
        "native",
        "input",
        "result",
      ]);
      if (e.kind !== "tool" && e.kind !== "worker")
        throw new Error("Invalid evidence kind");
      if (
        e.native !== undefined &&
        (e.kind !== "tool" || e.input === undefined || e.result === undefined)
      )
        throw new Error("Missing inspectable native evidence");
      return {
        id: text(e.id),
        kind: e.kind,
        text: text(e.text),
        ...(e.criterion === undefined ? {} : { criterion: text(e.criterion) }),
        ...(e.native === undefined
          ? {}
          : {
              native: parseNativeRef(e.native),
              input: structuredClone(e.input),
              result: structuredClone(e.result),
            }),
      };
    }),
  };
}
export function parseWorkerSnapshot(value: unknown): WorkerSnapshot {
  const v = object(value);
  exact(v, [
    "dataDir",
    "location",
    "sessionID",
    "incarnation",
    "sequence",
    "invalidationVersion",
    "messageIDs",
    "contextFingerprint",
    "nativeBoundary",
    "background",
    "publishedAt",
  ]);
  if (JSON.stringify(v).length > 32_000)
    throw new Error("Oversized native snapshot");
  const messageIDs = list(v.messageIDs, text);
  if (
    !messageIDs.length ||
    messageIDs.length > 200 ||
    new Set(messageIDs).size !== messageIDs.length ||
    v.nativeBoundary !== messageIDs.at(-1)
  )
    throw new Error("Invalid native boundary");
  const background = list(v.background, (entry): WorkerBackground => {
    const b = object(entry);
    const sessionID = text(b.sessionID);
    if (b.kind === "shell") {
      exact(b, ["kind", "sessionID", "shellID", "command"]);
      return {
        kind: "shell",
        sessionID,
        shellID: text(b.shellID),
        command: text(b.command),
      };
    }
    if (b.kind === "subagent") {
      exact(b, ["kind", "sessionID", "childSessionID", "agent", "description"]);
      return {
        kind: "subagent",
        sessionID,
        childSessionID: text(b.childSessionID),
        agent: text(b.agent),
        description: text(b.description),
      };
    }
    if (b.kind === "image") {
      exact(b, ["kind", "sessionID", "path", "model"]);
      return {
        kind: "image",
        sessionID,
        path: text(b.path),
        model: text(b.model),
      };
    }
    throw new Error("Unknown native background work");
  });
  if (
    background.length > 200 ||
    !/^[a-f0-9]{64}$/.test(String(v.contextFingerprint))
  )
    throw new Error("Invalid native snapshot bound");
  return {
    dataDir: text(v.dataDir),
    location: text(v.location),
    sessionID: text(v.sessionID),
    incarnation: text(v.incarnation),
    sequence: integer(v.sequence, 1),
    invalidationVersion: integer(v.invalidationVersion),
    messageIDs,
    contextFingerprint: text(v.contextFingerprint),
    nativeBoundary: text(v.nativeBoundary),
    background,
    publishedAt: integer(v.publishedAt),
  };
}
export function parseIntent(
  value: unknown,
): import("./dispatch.ts").DispatchIntent {
  const v = object(value);
  exact(v, [
    "id",
    "taskID",
    "workerID",
    "identity",
    "text",
    "nonprogress",
    "status",
  ]);
  if (integer(v.nonprogress) > AUTOMATION_LIMITS.nonprogress)
    throw new Error("Invalid durable intent allowance");
  if (!["reserved", "admitted", "ambiguous"].includes(String(v.status)))
    throw new Error("Invalid intent status");
  const intent = {
    id: text(v.id),
    taskID: text(v.taskID),
    workerID: text(v.workerID),
    identity: text(v.identity),
    text: text(v.text),
    nonprogress: integer(v.nonprogress),
    status: v.status as import("./dispatch.ts").DispatchIntent["status"],
  };
  if (intent.id.length > 200 || intent.text.length > 12_000)
    throw new Error("Oversized intent");
  return intent;
}
export function parseSupport(
  value: unknown,
): import("./evaluator.ts").CriterionSupport[] {
  return list(value, (entry) => {
    const v = object(entry);
    return { criterion: text(v.criterion), evidenceID: text(v.evidenceID) };
  });
}
export function parseCoordinatorState(value: unknown): CoordinatorState {
  if (value === undefined)
    return {
      version: 1,
      bindings: [],
      snapshots: [],
      intents: [],
      completions: [],
    };
  const v = object(value);
  exact(v, [
    "version",
    "bindings",
    "snapshots",
    "intents",
    "completions",
    "observer",
  ]);
  if (v.version !== 1) throw new Error("Unsupported durable state");
  assertStateBounds(v);
  const state: CoordinatorState = {
    version: 1,
    bindings: list(v.bindings, parseBinding),
    snapshots: list(v.snapshots, parseSnapshot),
    intents: list(v.intents, (entry) => {
      const i = object(entry);
      exact(i, [
        "intent",
        "revision",
        "epoch",
        "generation",
        "createdAt",
        "kind",
        "validation",
      ]);
      if (i.kind !== undefined && i.kind !== "initial" && i.kind !== "manual")
        throw new Error("Invalid delivery kind");
      if (
        i.kind === "manual" &&
        (i.generation !== 0 ||
          i.validation !== undefined ||
          object(i.intent).nonprogress !== 0)
      )
        throw new Error("Invalid manual delivery authority");
      return {
        intent: parseIntent(i.intent),
        revision: integer(i.revision, 1),
        epoch: integer(i.epoch, 1),
        generation: integer(i.generation, i.kind === undefined ? 1 : 0),
        createdAt: integer(i.createdAt),
        ...(i.kind === undefined
          ? {}
          : { kind: i.kind as "initial" | "manual" }),
        ...(i.validation === undefined
          ? {}
          : { validation: parseStrictValidationResult(i.validation) }),
      };
    }),
    completions: list(v.completions, (entry) => {
      const c = object(entry);
      exact(c, [
        "taskID",
        "workerID",
        "revision",
        "epoch",
        "generation",
        "support",
        "evidence",
        "validation",
      ]);
      return {
        taskID: text(c.taskID),
        workerID: text(c.workerID),
        revision: integer(c.revision, 1),
        epoch: integer(c.epoch, 1),
        generation: integer(c.generation, 1),
        support: parseSupport(c.support),
        evidence: (() => {
          const e = object(c.evidence);
          exact(e, ["taskID", "workerID", "turn", "fingerprint", "native"]);
          const native = list(e.native, parseNativeRef);
          if (
            native.length > VALIDATION_BOUNDS.nativeRefs ||
            new Set(native.map((r) => JSON.stringify([r.messageID, r.callID])))
              .size !== native.length
          )
            throw new Error("Invalid durable native references");
          return {
            taskID: text(e.taskID),
            workerID: text(e.workerID),
            turn: integer(e.turn),
            fingerprint: digest(e.fingerprint),
            native,
          };
        })(),
        validation: parseStrictValidationResult(c.validation),
      };
    }),
  };
  if (v.observer !== undefined) {
    const o = object(v.observer);
    exact(o, [
      "dataDir",
      "coordinatorLocation",
      "coordinatorID",
      "verifier",
      "generation",
      "sequence",
    ]);
    state.observer = {
      coordinatorID: text(o.coordinatorID),
      dataDir: text(o.dataDir),
      coordinatorLocation: text(o.coordinatorLocation),
      verifier: text(o.verifier),
      generation: integer(o.generation, 1),
      sequence: integer(o.sequence),
    };
  }
  if (
    new Set(state.bindings.map((b) => b.id)).size !== state.bindings.length ||
    new Set(state.bindings.map((b) => b.workerID)).size !==
      state.bindings.length ||
    new Set(state.intents.map((i) => i.intent.id)).size !==
      state.intents.length ||
    new Set(state.snapshots.map((s) => JSON.stringify([s.id, s.version])))
      .size !== state.snapshots.length ||
    state.bindings.filter((b) => b.status !== "complete").length >
      AUTOMATION_LIMITS.activeWorkers
  )
    throw new Error("Ambiguous durable ownership");
  for (const b of state.bindings) {
    const shared = b.shared ?? [];
    if (
      new Set(shared.map((r) => JSON.stringify([r.id, r.version]))).size !==
        shared.length ||
      shared.some(
        (r) =>
          state.snapshots.filter(
            (s) =>
              s.id === r.id &&
              s.version === r.version &&
              s.group === b.group &&
              s.recipients.includes(b.id),
          ).length !== 1,
      )
    )
      throw new Error("Unbound durable sharing");
  }
  for (const s of state.snapshots)
    if (
      !s.recipients.length ||
      new Set(s.recipients).size !== s.recipients.length ||
      s.recipients.some(
        (id) => !state.bindings.some((b) => b.id === id && b.group === s.group),
      )
    )
      throw new Error("Unbound durable snapshot recipients");
  for (const i of state.intents) {
    const b = state.bindings.find((b) => b.id === i.intent.taskID);
    if (
      !b ||
      i.intent.workerID !== b.workerID ||
      i.revision > b.revision ||
      i.epoch > b.epoch ||
      (i.kind === undefined && (b.followups === 0 || !i.validation))
    )
      throw new Error("Unbound durable intent");
    if (
      i.validation &&
      (i.validation.status !== "accept" ||
        i.validation.identity.taskID !== b.id ||
        i.validation.identity.workerID !== b.workerID ||
        i.validation.identity.location !== b.location ||
        i.validation.identity.revision !== i.revision ||
        i.validation.identity.epoch !== i.epoch ||
        i.validation.identity.generation !== i.generation ||
        fingerprint(i.validation.identity) !== i.intent.identity)
    )
      throw new Error("Unbound durable validation receipt");
  }
  for (const b of state.bindings)
    if (
      state.intents.filter(
        (i) => i.intent.taskID === b.id && i.kind === undefined,
      ).length > b.followups
    )
      throw new Error("Durable intents exceed consumed allowance");
  for (const c of state.completions) {
    const b = state.bindings.find((b) => b.id === c.taskID);
    const identity = c.validation.identity;
    if (
      !b ||
      b.status !== "complete" ||
      c.workerID !== b.workerID ||
      c.revision !== b.revision ||
      c.epoch !== b.epoch ||
      c.evidence.taskID !== b.id ||
      c.evidence.workerID !== b.workerID ||
      c.validation.status !== "accept" ||
      identity.taskID !== b.id ||
      identity.workerID !== b.workerID ||
      identity.location !== b.location ||
      identity.revision !== b.revision ||
      identity.epoch !== b.epoch ||
      identity.generation !== c.generation ||
      identity.turn !== c.evidence.turn ||
      identity.evidenceFingerprint !== c.evidence.fingerprint ||
      fingerprint(identity.sharedVersions) !== fingerprint(b.shared ?? []) ||
      !c.validation.criteria ||
      c.validation.criteria.length !== b.criteria.length ||
      !b.criteria.every((criterion) => {
        const matches = c.validation.criteria!.filter(
          (r) => r.criterion === criterion,
        );
        return (
          matches.length === 1 &&
          matches[0]!.status === "accept" &&
          matches[0]!.evidence.length > 0 &&
          matches[0]!.evidence.every(
            (ref) =>
              c.evidence.native.filter(
                (r) => fingerprint(r) === fingerprint(ref),
              ).length === 1,
          )
        );
      }) ||
      c.support.length !== b.criteria.length ||
      !b.criteria.every(
        (criterion) =>
          c.support.filter((s) => s.criterion === criterion).length === 1 &&
          c.validation
            .criteria!.find((c) => c.criterion === criterion)
            ?.evidence.some(
              (r) =>
                r.callID ===
                c.support.find((s) => s.criterion === criterion)?.evidenceID,
            ),
      )
    )
      throw new Error("Invalid completion provenance");
  }
  if (
    state.bindings.some(
      (b) =>
        b.status === "complete" &&
        state.completions.filter((c) => c.taskID === b.id).length !== 1,
    )
  )
    throw new Error("Completion receipt missing");
  return state;
}
