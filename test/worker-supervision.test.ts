import { describe, expect, it, spyOn } from "bun:test";
import { Effect, Logger, References } from "effect";
import { DiagnosticToken } from "../src/native-connection.ts";
import {
  buildContext,
  nativeToolEvidence,
  type TaskEvidence,
} from "../src/context.ts";
import {
  Supervisor,
  type SupervisionPort,
  type WorkerObservation,
} from "../src/lifecycle.ts";
import type { DispatchIntent, SupervisionResult } from "../src/dispatch.ts";
import { ServerSupervision } from "../src/supervision.ts";
import { parseCoordinatorState, type WorkerBinding } from "../src/state.ts";
import { dispatchFollowup, followupText } from "../src/dispatch.ts";
import {
  createWorkerObserver,
  hostDiagnostics,
  promisePlugin,
  createNativeBackend,
  type NativeBackendHost,
  type WorkerObserverHost,
} from "../src/server.ts";
import { CoordinatorOwnership } from "../src/ownership.ts";
import { createHash } from "node:crypto";
import { fixtureApproval } from "./host.ts";

import { coordinatorDefinition } from "./host.ts";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// spec: openspec/specs/worker-coordination/spec.md
describe("Operational diagnostic boundaries", () => {
  it("Routes diagnostics through host logging", async () => {
    const records: { level: string; message: unknown }[] = [];
    const emit = Effect.runSync(
      hostDiagnostics.pipe(
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make((entry) => {
              records.push({ level: entry.logLevel, message: entry.message });
            }),
          ]),
        ),
        Effect.provideService(References.MinimumLogLevel, "Info"),
      ),
    );
    await Promise.resolve();
    emit("debug", "tool.started");
    emit("info", "setup.completed");
    emit("warn", "inventory.degraded", { count: 2 });
    expect(records.map((record) => record.level)).toEqual(["Info", "Warn"]);
    expect(JSON.stringify(records)).toContain("backseat");
    emit("warn", "native.request.failed", {
      requestCategory: "sessions",
      requestDurationMs: 12.5,
      httpStatus: 503,
      errorCode: "ECONNRESET",
    });
    expect(records.flatMap((record) => record.message)).toContainEqual({
      service: "backseat",
      event: "native.request.failed",
      classification: "unknown",
      requestCategory: "sessions",
      requestDurationMs: 12.5,
      httpStatus: 503,
      errorCode: "ECONNRESET",
    });
    await promisePlugin(emit).setup({ app: { version: "2.2.4" } } as Parameters<
      ReturnType<typeof promisePlugin>["setup"]
    >[0]);
    expect(JSON.stringify(records)).toContain("setup.degraded");
    expect(JSON.stringify(records)).toContain("validation");
  });
  it("Excludes sensitive diagnostic data", async () => {
    const records: unknown[] = [];
    const legacy: string[] = [];
    const sentinel = "PRIVATE_DIAGNOSTIC_SENTINEL";
    const emit = Effect.runSync(
      hostDiagnostics.pipe(
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([Logger.make((entry) => records.push(entry.message))]),
        ),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      (chunk) => {
        legacy.push(String(chunk));
        return true;
      },
    );
    const f = await observerFixture(emit);
    try {
      f.host.session.context = async () => {
        throw new Error(sentinel);
      };
      await f.observer.idle({ sessionID: "worker", background: [] });
      for (const level of ["debug", "info", "warn", "error"] as const) {
        emit(level, "native.failed", {
          error: new Error(sentinel),
          message: sentinel,
          service: sentinel,
          phase: sentinel,
          classification: sentinel,
          correlation: sentinel,
          cursor: sentinel,
          sessionID: sentinel,
          durationMs: Infinity,
          count: -1,
          continuation: sentinel,
          requestCategory: sentinel,
          errorCode: sentinel,
          requestDurationMs: Infinity,
          httpStatus: 600,
        });
      }
      emit("error", "native.failed", {
        correlation: Object.assign(Object.create(DiagnosticToken.prototype), {
          value: sentinel,
        }),
      });
      for (const invalid of [-1, NaN, Infinity, "200", 99, 600, 200.5]) {
        emit("warn", "native.request.failed", {
          requestCategory: sentinel,
          errorCode: sentinel,
          httpStatus: invalid,
          requestDurationMs: -1,
        });
      }
    } finally {
      await f.cleanup();
      stderr.mockRestore();
    }
    expect(JSON.stringify({ records, legacy })).not.toContain(sentinel);
    expect(records.length).toBeGreaterThan(0);
    const projected = records.flat() as Record<string, unknown>[];
    const requests = projected.filter(
      (record) => record.event === "native.request.failed",
    );
    expect(requests).toHaveLength(7);
    for (const record of requests)
      expect(record).toEqual({
        service: "backseat",
        event: "native.request.failed",
        classification: "unknown",
      });
    expect(
      projected.filter((record) => record.event === "native.failed"),
    ).toHaveLength(4);
    for (const record of projected.filter(
      (record) => record.event === "native.failed",
    )) {
      expect(record).toEqual({
        service: "backseat",
        event: "native.failed",
        classification: "unknown",
      });
    }
  });
});

async function observerFixture(
  diagnostics?: WorkerObserverHost["diagnostics"],
) {
  const values = new Map<string, unknown>();
  const sessions = new Map<string, { parentID?: string; directory: string }>([
    ["worker", { directory: "/project/api" }],
    ["child", { parentID: "worker", directory: "/project/child" }],
  ]);
  const messages: Awaited<
    ReturnType<WorkerObserverHost["session"]["context"]>
  > = [
    {
      type: "idle",
      id: "message-7",
      time: { created: 7 },
      outcome: "succeeded",
    },
  ];
  const host: WorkerObserverHost = {
    ...(diagnostics ? { diagnostics } : {}),
    plugin: {
      async list() {
        return {
          location: { directory: "/project/api" },
          data: [
            {
              id: "backseat",
              source: { type: "local", path: "/project/plugin" },
              features: { server: true },
              state: { status: "active" },
            },
          ],
        };
      },
    },
    session: {
      async get(input) {
        const s = sessions.get(input.sessionID);
        if (!s) throw new Error("Unavailable ancestry");
        return {
          id: input.sessionID,
          ...(s.parentID ? { parentID: s.parentID } : {}),
          agent:
            input.sessionID === "coordinator"
              ? coordinatorDefinition.id
              : "engineer",
          location: { directory: s.directory },
          projectID: "p",
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          ...(input.sessionID === "worker"
            ? { outcome: "succeeded" as const }
            : {}),
          time: {
            created: 1,
            updated: 1,
            ...(input.sessionID === "worker" ? { busy: 1, idle: 7 } : {}),
          },
        };
      },
      async context() {
        return structuredClone(messages);
      },
    },
    storage: {
      async get(key) {
        return structuredClone(values.get(key)) as Awaited<
          ReturnType<NativeBackendHost["storage"]["get"]>
        >;
      },
      async set(key, value) {
        values.set(key, structuredClone(value));
      },
    },
    async canonical(location) {
      return location;
    },
  };
  const home = "/project/coordinator";
  const root = "coordinator:state";
  const task = fixture().task;
  values.set(root, {
    version: 1,
    bindings: [task],
    snapshots: [],
    intents: [],
    completions: [],
  });
  const owner = new CoordinatorOwnership(home, "owner", {
    async inspect() {
      return { safe: true };
    },
    async acquire() {
      return true;
    },
    async release() {},
    async approveRecovery() {},
    async recover() {},
  });
  const nativeHost: NativeBackendHost = {
    ...host,
    session: {
      get: host.session.get,
      context: host.session.context,
      async create() {
        throw new Error("Unexpected create");
      },
      async prompt() {
        throw new Error("Unexpected prompt");
      },
    },
    agent: {
      async list(input) {
        return {
          location: { directory: input?.location?.directory ?? task.location },
          data: [coordinatorDefinition],
        };
      },
    },
    permission: fixtureApproval(home),
    async generate() {
      throw new Error("Unexpected evaluation");
    },
  };
  const backend = await createNativeBackend(nativeHost, owner, home);
  const observer = await createWorkerObserver(host, home, task.location);
  return {
    values,
    sessions,
    messages,
    host,
    nativeHost,
    home,
    root,
    task,
    backend,
    observer,
    async read() {
      return backend.observe({ taskID: task.id, workerID: task.workerID });
    },
    async cleanup() {
      await observer.dispose();
      await backend.dispose();
    },
  };
}
async function completionFixture(
  action: "complete" | "continue" = "complete",
  projection: "full" | "pre-idle" = "full",
) {
  const f = await observerFixture();
  f.sessions.set("coordinator", { directory: f.home });
  f.nativeHost.agent.list = async (input) => ({
    location: { directory: input?.location?.directory ?? f.task.location },
    data: [
      coordinatorDefinition,
      {
        id: "engineer",
        name: "Engineer",
        request: { settings: {}, headers: {}, body: {} },
        mode: "all",
        hidden: false,
        permissions: [],
      },
    ],
  });
  const identity = {
    sessionID: "coordinator",
    agent: coordinatorDefinition.id,
    messageID: "message",
    id: "fixture",
  };
  const { generation } = await f.backend.startSupervision(identity);
  const held = (await f.backend.inspect()).bindings[0]!;
  const call = {
    type: "tool" as const,
    id: "native-call",
    name: "shell",
    state: {
      status: "completed" as const,
      input: { command: "verify api" },
      content: [{ type: "text" as const, text: "API verified" }] as [
        { type: "text"; text: string },
      ],
    },
    time: { created: 1, completed: 2 },
  };
  f.messages.unshift({
    id: "assistant-7",
    type: "assistant",
    agent: "engineer",
    model: { providerID: "provider", id: "model" },
    time: { created: 1, completed: 2 },
    content: [call],
  });
  const entry = nativeToolEvidence("assistant-7", call)!;
  const terminal = projection === "pre-idle" ? f.messages.pop() : undefined;
  await f.observer.idle({ sessionID: held.workerID, background: [] });
  if (terminal) f.messages.push(terminal);
  const evidence: TaskEvidence = {
    taskID: held.id,
    workerID: held.workerID,
    turn: 7,
    entries: [entry],
  };
  let afterValidation: (() => Promise<void> | void) | undefined;
  let validated = false;
  f.nativeHost.observeNative = async (binding, snapshots, snapshot) => {
    if (validated && afterValidation) {
      const callback = afterValidation;
      afterValidation = undefined;
      await callback();
    }
    const context = buildContext(binding, evidence, snapshots, 10000);
    if (context.status !== "ready") throw new Error(context.reason);
    return {
      turn: evidence.turn,
      state: "settled",
      asks: [],
      snapshot,
      context: context.context,
    };
  };
  const task = (await f.backend.inspect()).bindings[0]!;
  let calls = 0;
  let validation: unknown =
    action === "complete"
      ? {
          status: "accept",
          rationale:
            "Current native verification output supports the API criterion.",
          criteria: [
            {
              criterion: "API verified",
              status: "accept",
              rationale: "The inspected command and result verify the API.",
              evidence: [entry.native],
            },
          ],
        }
      : {
          status: "accept",
          rationale:
            "The exact verification step stays in scope and grants no consent.",
        };
  f.nativeHost.generate = async (_context, request) => {
    calls++;
    if (request) {
      validated = true;
      return validation;
    }
    return action === "complete"
      ? {
          taskID: task.id,
          workerID: task.workerID,
          action: "complete",
          support: [{ criterion: "API verified", evidenceID: entry.id }],
        }
      : {
          taskID: task.id,
          workerID: task.workerID,
          action: "continue",
          nextStep: "Verify API",
          scope: task.scope,
          progress: true,
        };
  };
  const sends: { id: string; text: string }[] = [];
  f.nativeHost.session.prompt = async (input) => {
    sends.push({ id: input.id!, text: input.text });
    return {
      id: input.id!,
      sessionID: input.sessionID,
      time: { created: Date.now() },
      type: "user",
      payload: { text: input.text },
      delivery: input.delivery ?? "steer",
    };
  };
  return {
    ...f,
    task,
    entry,
    evidence,
    generation,
    identity,
    sends,
    calls: () => calls,
    validation(value: unknown) {
      validation = value;
    },
    afterValidation(callback: () => Promise<void> | void) {
      afterValidation = callback;
    },
    async run() {
      await f.backend.resumeTask(task.id, identity);
      return parseCoordinatorState(f.values.get(f.root));
    },
  };
}

function fixture() {
  let task: WorkerBinding = {
    id: "task",
    title: "Fix API",
    goal: "Verify API",
    criteria: ["API verified"],
    constraints: ["No consent"],
    scope: ["api"],
    location: "/project/api",
    agent: "engineer",
    workerID: "worker",
    revision: 1,
    epoch: 1,
    status: "active",
    followups: 0,
    nonprogress: 0,
  };
  const native = nativeToolEvidence("message-7", {
    type: "tool",
    id: "tool-7",
    name: "shell",
    state: {
      status: "completed",
      input: { command: "verify api" },
      content: [{ type: "text", text: "API verified" }],
    },
    time: { created: 1, completed: 2 },
  })!;
  const evidence: TaskEvidence = {
    taskID: task.id,
    workerID: task.workerID,
    turn: 7,
    entries: [{ ...native, criterion: "API verified" }],
  };
  const built = buildContext(task, evidence, [], 10_000);
  if (built.status !== "ready") throw new Error(built.reason);
  let observation: WorkerObservation = {
    turn: 7,
    state: "settled",
    asks: [],
    context: built.context,
  };
  let intent: DispatchIntent | undefined;
  let suggestion: unknown = {
    taskID: "task",
    workerID: "worker",
    action: "continue",
    nextStep: "Run API verification",
    scope: ["api"],
    progress: true,
  };
  let onSuggest = () => {};
  let onAdmit = () => {};
  let now = 1000;
  let delivery: "admitted" | "absent" | "unknown" = "unknown";
  let admission: "admitted" | "ambiguous" = "admitted";
  let allowed = true;
  let validStep = true;
  let validCompletion = true;
  const sends: DispatchIntent[] = [];
  const records: SupervisionResult[] = [];
  const reads: string[] = [];
  const contexts: unknown[] = [];
  const recordedSupport: unknown[] = [];
  const port: SupervisionPort = {
    binding: async () => structuredClone(task),
    inventory: async () => {
      reads.push("inventory");
      return [structuredClone(task)];
    },
    observe: async () => {
      reads.push("observe");
      return structuredClone(observation);
    },
    authorized: async (generation) => allowed && generation === "1",
    suggest: async (context) => {
      contexts.push(context);
      onSuggest();
      return suggestion;
    },
    validateStep: async () => validStep,
    validateCompletion: async () => validCompletion,
    unresolved: async () =>
      intent?.status !== "admitted" ? intent : undefined,
    reserve: async (_binding, value) => {
      if ((intent && intent.status !== "admitted") || task.followups >= 3)
        return false;
      intent = value;
      task.followups++;
      task.nonprogress = value.nonprogress;
      return true;
    },
    delivery: async () => {
      reads.push("delivery");
      return delivery;
    },
    admit: async (_binding, value) => {
      expect(intent?.id).toBe(value.id);
      expect(task.followups).toBeGreaterThan(0);
      sends.push(value);
      onAdmit();
      return admission;
    },
    finish: async (value, status) => {
      intent = { ...value, status };
    },
    record: async (_binding, result, support) => {
      records.push(result);
      recordedSupport.push(support);
      if (result.status === "held" || result.status === "complete")
        task.status = result.status;
    },
    nextPromptID: () => `prompt-${task.followups + 1}`,
    now: () => now,
  };
  const supervisor = new Supervisor(port);
  return {
    port,
    supervisor,
    sends,
    records,
    recordedSupport,
    reads,
    contexts,
    get task() {
      return task;
    },
    set task(value: WorkerBinding) {
      task = value;
    },
    get observation() {
      return observation;
    },
    set observation(value: WorkerObservation) {
      observation = value;
    },
    get intent() {
      return intent;
    },
    set intent(value: DispatchIntent | undefined) {
      intent = value;
    },
    set suggestion(value: unknown) {
      suggestion = value;
    },
    set onSuggest(value: () => void) {
      onSuggest = value;
    },
    set onAdmit(value: () => void) {
      onAdmit = value;
    },
    set now(value: number) {
      now = value;
    },
    set delivery(value: typeof delivery) {
      delivery = value;
    },
    set admission(value: typeof admission) {
      admission = value;
    },
    set allowed(value: boolean) {
      allowed = value;
    },
    set validStep(value: boolean) {
      validStep = value;
    },
    set validCompletion(value: boolean) {
      validCompletion = value;
    },
  };
}
async function ready(f: ReturnType<typeof fixture>, supervisor = f.supervisor) {
  await supervisor.reconnect("1");
  await supervisor.rearm("1");
}
function pending(): DispatchIntent {
  return {
    id: "lost-prompt",
    taskID: "task",
    workerID: "worker",
    identity: "old",
    text: "existing",
    nonprogress: 0,
    status: "reserved",
  };
}

async function assertOuterSupervisionFailures() {
  for (const failure of [
    "binding",
    "observation",
    "authorization",
    "target",
  ] as const) {
    const f = fixture();
    await ready(f);
    if (failure === "binding")
      f.port.binding = async () => {
        throw new Error("Unreadable binding");
      };
    if (failure === "observation")
      f.port.observe = async () => {
        throw new Error("Unreadable observation");
      };
    if (failure === "authorization") f.allowed = false;
    if (failure === "target") f.task.id = "other-task";
    expect((await f.supervisor.supervise("task")).status, failure).toBe("held");
    expect(f.sends, failure).toHaveLength(0);
    expect(f.contexts, failure).toHaveLength(0);
  }
}

async function assertReservationFences() {
  for (const change of ["disconnect", "generation", "authorization"] as const) {
    const f = fixture();
    await ready(f);
    const reserve = f.port.reserve;
    f.port.reserve = async (...args) => {
      const reserved = await reserve(...args);
      if (change === "disconnect") f.supervisor.close();
      if (change === "generation") await f.supervisor.reconnect("2");
      if (change === "authorization") f.allowed = false;
      return reserved;
    };
    expect((await f.supervisor.supervise("task")).status, change).toBe("held");
    expect(f.intent?.status, change).toBe("ambiguous");
    expect(f.task.followups, change).toBe(1);
    expect(f.sends, change).toHaveLength(0);
  }
}

async function assertBoundedReservationRejections() {
  for (const oversized of ["id", "text"] as const) {
    const f = fixture();
    const intent = {
      ...pending(),
      id: oversized === "id" ? "x".repeat(1000) : "prompt-next",
      text: oversized === "text" ? "x".repeat(100000) : "Verify API",
    };
    const result = await dispatchFollowup(f.task, intent, f.port, {
      current: async () => undefined,
      fence: () => undefined,
      afterAdmission: async () => undefined,
    });
    expect(result.status).toBe("held");
    expect(result.reason).toContain("Invalid bounded delivery intent");
    expect(f.task.followups).toBe(0);
    expect(f.intent).toBeUndefined();
    expect(f.sends).toHaveLength(0);
  }
  const rejected = fixture();
  await ready(rejected);
  rejected.port.reserve = async () => false;
  expect((await rejected.supervisor.supervise("task")).reason).toContain(
    "Reservation rejected",
  );
  expect(rejected.sends).toHaveLength(0);
  expect(rejected.task.followups).toBe(0);
}

// spec: openspec/specs/worker-supervision/spec.md
describe("Settled-work supervision", () => {
  it("Evaluates a settled cross-project worker", async () => {
    const server = fixture();
    const runtime = new ServerSupervision(server.port);
    await runtime.start(1);
    await runtime.wake("worker");
    expect(server.sends).toHaveLength(0);
    expect((await runtime.rearm(1)).status).toBe("reconciled");
    await runtime.wake("unrelated-session");
    expect(server.sends).toHaveLength(0);
    await Promise.all([runtime.wake("worker"), runtime.wake("worker")]);
    expect(server.sends).toHaveLength(1);
    expect(server.sends[0]?.workerID).toBe("worker");
    runtime.close();
    await runtime.wake("worker");
    expect(server.sends).toHaveLength(1);
    const f = fixture();
    await ready(f);
    expect((await f.supervisor.supervise("task")).status).toBe("continued");
    expect(f.reads).toContain("observe");
    expect(f.contexts).toHaveLength(1);
    expect(f.sends[0]?.workerID).toBe("worker");
    const native = await observerFixture();
    const before = structuredClone(native.values.get(native.root));
    await native.observer.idle({ sessionID: "worker", background: [] });
    const observed = await native.read();
    expect(observed.snapshot).toMatchObject({
      location: "/project/api",
      sessionID: "worker",
      messageIDs: ["message-7"],
      background: [],
      sequence: 1,
      invalidationVersion: 0,
    });
    expect(observed.snapshot?.contextFingerprint).toBe(hash(native.messages));
    expect(native.values.get(native.root)).toEqual(before);
    expect(
      (
        await native.backend.observe({
          taskID: native.task.id,
          workerID: "child",
        })
      ).snapshot,
    ).toBeUndefined();
    await native.cleanup();
    const modes = [
      "terminal",
      "terminal-during-idle",
      "terminal-after-success-projection",
      "usage-during-idle",
      "usage-during-terminal",
      "unrelated-update",
      "startup",
      "global-update",
      "unrelated-failure",
    ] as const;
    const availability: { mode: string; available: boolean }[] = [];
    for (const mode of modes) {
      const n = await observerFixture();
      // Actual bundled 2.2.5 SessionRunner/SessionExecution ordering: completed
      // call/step projections exist at the hook; success appends its idle marker
      // after the hook. Stream callbacks for earlier projections can arrive late.
      const tokens = {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      };
      const content = [{ type: "text" as const, text: "API verified" }] as [
        { type: "text"; text: string },
      ];
      let projection: Promise<void> | undefined;
      const deliverDuringContext = (
        event: Parameters<typeof n.observer.event>[0],
      ) => {
        const context = n.host.session.context;
        n.host.session.context = async (input) => {
          const messages = await context(input);
          n.host.session.context = context;
          projection = n.observer.event(event);
          return messages;
        };
      };
      const usage = {
        id: "evt_usage",
        created: 2,
        type: "session.usage.updated" as const,
        location: { directory: n.task.location },
        data: { sessionID: "worker", cost: 0, tokens },
      };
      n.messages.splice(0, n.messages.length, {
        id: "msg_step",
        type: "assistant",
        agent: "engineer",
        model: { id: "model", providerID: "provider" },
        time: { created: 1, completed: 2 },
        finish: "stop",
        cost: 0,
        tokens,
        content: [
          {
            type: "tool",
            id: "call",
            name: "shell",
            executed: true,
            time: { created: 1, completed: 1 },
            state: {
              status: "completed",
              input: { command: "verify api" },
              content,
            },
          },
        ],
      });
      if (mode === "startup")
        await n.observer.event({
          id: "evt_startup",
          created: 3,
          type: "plugin.updated",
          location: { directory: n.task.location },
          data: {},
        });
      if (mode === "usage-during-idle") deliverDuringContext(usage);
      if (mode === "terminal-during-idle")
        deliverDuringContext({
          id: "evt_step",
          created: 2,
          type: "session.step.ended",
          durable: { aggregateID: "worker", seq: 1, version: 1 },
          data: {
            sessionID: "worker",
            assistantMessageID: "msg_step",
            finish: "stop",
            cost: 0,
            tokens,
          },
        });
      await n.observer.idle({ sessionID: "worker", background: [] });
      const hookSnapshot = (await n.read()).snapshot;
      if (
        mode === "terminal" ||
        mode === "usage-during-terminal" ||
        mode === "terminal-after-success-projection"
      ) {
        if (mode === "terminal-after-success-projection")
          n.messages.push({
            id: "msg_terminal",
            type: "idle",
            outcome: "succeeded",
            time: { created: 3 },
          });
        await n.observer.event({
          id: "evt_tool",
          created: 1,
          type: "session.tool.success",
          durable: { aggregateID: "worker", seq: 1, version: 2 },
          data: {
            sessionID: "worker",
            assistantMessageID: "msg_step",
            id: "call",
            executed: true,
            content,
          },
        });
        await n.observer.event({
          id: "evt_step",
          created: 2,
          type: "session.step.ended",
          durable: { aggregateID: "worker", seq: 2, version: 1 },
          data: {
            sessionID: "worker",
            assistantMessageID: "msg_step",
            finish: "stop",
            cost: 0,
            tokens,
          },
        });
        if (mode === "terminal-after-success-projection")
          expect((await n.read()).snapshot?.messageIDs).toEqual(
            hookSnapshot?.messageIDs,
          );
        if (mode !== "terminal-after-success-projection")
          n.messages.push({
            id: "msg_terminal",
            type: "idle",
            outcome: "succeeded",
            time: { created: 3 },
          });
        if (mode === "usage-during-terminal") deliverDuringContext(usage);
        await n.observer.event({
          id: "evt_terminal",
          created: 3,
          type: "session.execution.succeeded",
          durable: { aggregateID: "worker", seq: 3, version: 1 },
          data: { sessionID: "worker" },
        });
      } else if (
        mode !== "startup" &&
        mode !== "usage-during-idle" &&
        mode !== "terminal-during-idle"
      ) {
        if (mode === "unrelated-failure")
          n.host.plugin!.list = async () => ({
            location: { directory: n.task.location },
            data: [
              {
                id: "backseat",
                source: { type: "local", path: "/project/plugin" },
                features: { server: true },
                state: { status: "active" },
              },
              {
                id: "other",
                source: { type: "local", path: "/project/other-plugin" },
                features: { server: true },
                state: { status: "failed", error: "Other plugin failed" },
              },
            ],
          });
        await n.observer.event({
          id: "evt_update",
          created: 3,
          type: "plugin.updated",
          ...(mode === "global-update"
            ? {}
            : {
                location: {
                  directory:
                    mode === "unrelated-update"
                      ? "/project/other"
                      : n.task.location,
                },
              }),
          data: {},
        });
      }
      await projection;
      const observed = await n.read();
      availability.push({ mode, available: observed.snapshot !== undefined });
      if (observed.snapshot) {
        expect(observed.snapshot.invalidationVersion).toBe(0);
        expect(observed.snapshot.contextFingerprint).toBe(
          hash(n.messages.slice(0, observed.snapshot.messageIDs.length)),
        );
        expect(observed.snapshot.nativeBoundary).toBe(
          observed.snapshot.messageIDs.at(-1)!,
        );
        expect(observed.snapshot.background).toEqual([]);
        expect(hookSnapshot?.publishedAt).toBe(observed.snapshot.publishedAt);
        expect(observed.snapshot).toEqual(hookSnapshot!);
      }
      await n.cleanup();
    }
    expect(availability).toEqual(
      modes.map((mode) => ({ mode, available: true })),
    );
  });
  it("Defers background work and holds abnormal termination", async () => {
    const overflowAvailability: boolean[] = [];
    for (const [count, size] of [
      [1, 100_000],
      [30, 50_000],
    ]) {
      const n = await observerFixture();
      try {
        await n.observer.idle({ sessionID: "worker", background: [] });
        const storage = n.host.storage;
        let enter!: () => void, finish!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const waiting = new Promise<void>((resolve) => {
          finish = resolve;
        });
        let paused = false;
        n.host.storage = {
          ...storage,
          get: async (key) => {
            if (!paused) {
              paused = true;
              enter();
              await waiting;
            }
            return storage.get(key);
          },
        };
        const work = Array.from({ length: count! }, (_, index) =>
          n.observer.event({
            id: `evt_overflow_${index}`,
            created: index + 10,
            type: "plugin.updated",
            location: { directory: `/${"x".repeat(size!)}` },
            data: {},
          }),
        );
        await entered;
        finish();
        await Promise.all(work);
        overflowAvailability.push(!!(await n.read()).snapshot);
      } finally {
        await n.cleanup();
      }
    }
    expect(overflowAvailability).toEqual([false, false]);
    for (const state of [
      "running",
      "background",
      "unknown",
      "failed",
      "interrupted",
      "unreadable",
    ] as const) {
      const f = fixture();
      await ready(f);
      f.observation = { ...f.observation, state };
      const result = await f.supervisor.supervise("task");
      expect(result.reason).toContain(state);
      expect(result.status).toBe(
        state === "running" || state === "background" ? "deferred" : "held",
      );
      expect(f.sends).toHaveLength(0);
      expect(f.contexts).toHaveLength(0);
    }
    const native = await observerFixture();
    expect((await native.read()).snapshot).toBeUndefined();
    await native.observer.idle({
      sessionID: "worker",
      background: [
        {
          kind: "shell",
          sessionID: "child",
          shellID: "shell-child",
          command: "verify",
        },
      ],
    });
    expect((await native.read()).snapshot?.background).toHaveLength(1);
    // Verified generated 2.2.5 event shape; sequence is native durable aggregate
    // ordering, not a fabricated execution nonce or observer sequence.
    await native.observer.event({
      id: "event-1",
      created: 1,
      type: "session.execution.succeeded",
      durable: { aggregateID: "child", seq: 1, version: 1 },
      data: { sessionID: "child" },
    });
    expect((await native.read()).snapshot).toBeUndefined();
    await native.observer.idle({ sessionID: "worker", background: [] });
    expect((await native.read()).snapshot?.background).toEqual([]);
    await native.observer.event({
      id: "event-2",
      created: 2,
      type: "session.execution.started",
      durable: { aggregateID: "missing", seq: 1, version: 1 },
      data: { sessionID: "missing" },
    });
    expect((await native.read()).snapshot).toBeUndefined();
    await native.cleanup();
    for (const mode of [
      "changed-prefix",
      "new-start",
      "failed",
      "interrupted",
      "failed-observer",
      "same-location-shutdown",
      "unrelated-shutdown",
    ] as const) {
      const n = await observerFixture();
      await n.observer.idle({ sessionID: "worker", background: [] });
      if (mode === "failed-observer") {
        n.host.plugin!.list = async () => ({
          location: { directory: n.task.location },
          data: [
            {
              id: "backseat",
              source: { type: "local", path: "/project/plugin" },
              features: { server: true },
              state: { status: "failed", error: "Observer plugin failed" },
            },
          ],
        });
        await n.observer.event({
          id: "evt_update",
          created: 9,
          type: "plugin.updated",
          location: { directory: n.task.location },
          data: {},
        });
      } else if (mode.endsWith("shutdown")) {
        await n.observer.event({
          id: "evt_shutdown",
          created: 9,
          type: "location.shutdown",
          location: {
            directory:
              mode === "unrelated-shutdown"
                ? "/project/other"
                : n.task.location,
          },
          data: {},
        });
      } else {
        if (mode === "changed-prefix") n.messages[0]!.time.created++;
        if (mode === "new-start")
          await n.observer.event({
            id: "evt_started",
            created: 8,
            type: "session.execution.started",
            durable: { aggregateID: "worker", seq: 1, version: 1 },
            data: { sessionID: "worker" },
          });
        n.messages.push({
          id: "msg_terminal",
          type: "idle",
          outcome: "succeeded",
          time: { created: 9 },
        });
        const base = {
          id: "evt_terminal",
          created: 9,
          durable: {
            aggregateID: "worker",
            seq: mode === "new-start" ? 2 : 1,
            version: 1 as const,
          },
        };
        if (mode === "failed")
          await n.observer.event({
            ...base,
            type: "session.execution.failed",
            data: {
              sessionID: "worker",
              error: { type: "provider", message: "Failure" },
            },
          });
        else if (mode === "interrupted")
          await n.observer.event({
            ...base,
            type: "session.execution.interrupted",
            data: { sessionID: "worker", reason: "user" },
          });
        else
          await n.observer.event({
            ...base,
            type: "session.execution.succeeded",
            data: { sessionID: "worker" },
          });
      }
      expect((await n.read()).snapshot !== undefined).toBe(
        mode === "unrelated-shutdown",
      );
      await n.cleanup();
    }
    for (const mode of [
      "new-execution",
      "new-input",
      "new-tool",
      "descendant",
      "gap",
      "unmatched-terminal",
      "wrong-time",
      "failed",
      "interrupted",
    ] as const) {
      const n = await observerFixture();
      const tokens = {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      };
      n.messages.splice(0, n.messages.length, {
        id: "msg_step",
        type: "assistant",
        agent: "engineer",
        model: { id: "model", providerID: "provider" },
        time: { created: 1, completed: 2 },
        finish: "stop",
        cost: 0,
        tokens,
        content: [{ type: "text", text: "API verified" }],
      });
      await n.observer.event({
        id: "evt_started",
        created: 1,
        type: "session.execution.started",
        durable: { aggregateID: "worker", seq: 1, version: 1 },
        data: { sessionID: "worker" },
      });
      const base = {
        id: "evt_race",
        created: mode === "wrong-time" ? 3 : 2,
        durable: {
          aggregateID: "worker",
          seq: mode === "gap" ? 3 : 2,
          version: 1 as const,
        },
      };
      let event: Parameters<typeof n.observer.event>[0];
      if (mode === "new-execution")
        event = {
          ...base,
          type: "session.execution.started",
          data: { sessionID: "worker" },
        };
      else if (mode === "new-input")
        event = {
          ...base,
          type: "session.inbox.delivered",
          data: { sessionID: "worker", inboxID: "new-input" },
        };
      else if (mode === "new-tool")
        event = {
          ...base,
          type: "session.tool.called",
          data: {
            sessionID: "worker",
            assistantMessageID: "msg_step",
            id: "new-call",
            input: {},
            executed: true,
          },
        };
      else if (mode === "descendant")
        event = {
          ...base,
          type: "session.execution.succeeded",
          durable: { aggregateID: "child", seq: 1, version: 1 },
          data: { sessionID: "child" },
        };
      else if (mode === "failed")
        event = {
          ...base,
          type: "session.execution.failed",
          data: {
            sessionID: "worker",
            error: { type: "provider", message: "Failure" },
          },
        };
      else if (mode === "interrupted")
        event = {
          ...base,
          type: "session.execution.interrupted",
          data: { sessionID: "worker", reason: "user" },
        };
      else
        event = {
          ...base,
          type: "session.step.ended",
          data: {
            sessionID: "worker",
            assistantMessageID:
              mode === "unmatched-terminal" ? "other-step" : "msg_step",
            finish: "stop",
            cost: 0,
            tokens,
          },
        };
      const context = n.host.session.context;
      let projection: Promise<void> | undefined;
      n.host.session.context = async (input) => {
        const messages = await context(input);
        n.host.session.context = context;
        projection = n.observer.event(event);
        return messages;
      };
      await n.observer.idle({ sessionID: "worker", background: [] });
      await projection;
      expect((await n.read()).snapshot).toBeUndefined();
      await n.cleanup();
    }
  });
  it("Continues an eligible task within scope", async () => {
    for (const action of ["continue", "redirect"]) {
      const f = fixture();
      await ready(f);
      f.suggestion = {
        taskID: "task",
        workerID: "worker",
        action,
        nextStep: "Verify api",
        scope: ["api"],
        progress: true,
      };
      f.onAdmit = () => {
        f.observation = { ...f.observation, turn: 8, state: "running" };
      };
      expect((await f.supervisor.supervise("task")).status).toBe("continued");
      expect(f.sends[0]?.text).toContain("does not grant consent");
      expect(f.sends[0]?.text).toContain("Verify api");
      expect(f.task.followups).toBe(1);
      expect(f.task.agent).toBe("engineer");
    }
    for (const mode of ["admitted", "ambiguous"] as const) {
      const native = await completionFixture("continue");
      try {
        let reserved: unknown;
        const prompt = native.nativeHost.session.prompt;
        native.nativeHost.session.prompt = async (input) => {
          reserved = parseCoordinatorState(native.values.get(native.root))
            .intents[0];
          expect(reserved).toMatchObject({
            intent: {
              id: input.id,
              text: followupText(native.task, "Verify API"),
              status: "reserved",
            },
            generation: native.generation,
            validation: { status: "accept" },
          });
          if (mode === "ambiguous")
            throw new Error("Unconfirmed native admission");
          return prompt(input);
        };
        const stored = await native.run();
        expect(reserved).toBeDefined();
        expect(stored.bindings[0]?.followups).toBe(1);
        expect(stored.intents[0]?.intent.status).toBe(mode);
        expect(native.calls()).toBe(2);
        if (mode === "admitted") {
          expect(native.sends).toHaveLength(1);
          expect(stored.intents[0]?.intent.id).toBe(native.sends[0]?.id);
        } else {
          native.nativeHost.session.list = async () => ({
            data: [],
            cursor: {},
          });
          let removals = 0;
          native.nativeHost.session.remove = async () => {
            removals++;
          };
          await native.backend.deleteSession(native.task.workerID, {
            ...native.identity,
            id: "delete-call",
          });
          const fenced = await native.backend.inspect();
          expect(fenced.bindings[0]?.status).toBe("held");
          expect(fenced.intents[0]).toEqual(stored.intents[0]);
          expect(removals).toBe(1);
        }
      } finally {
        await native.cleanup();
      }
    }
  });
  it("Preserves human approval requests", async () => {
    for (const mode of ["pending", "during", "consent", "scope"]) {
      const f = fixture();
      await ready(f);
      if (mode === "pending")
        f.observation = { ...f.observation, asks: ["permission"] };
      if (mode === "during")
        f.onSuggest = () => f.supervisor.observeAsk("task");
      if (mode === "consent")
        f.suggestion = {
          taskID: "task",
          workerID: "worker",
          action: "continue",
          nextStep: "Approve permission",
          scope: ["api"],
          progress: true,
        };
      if (mode === "scope") f.validStep = false;
      expect((await f.supervisor.supervise("task")).reason).toMatch(
        /human|consent|scope/i,
      );
      expect(f.sends).toHaveLength(0);
      expect(f.task.status).toBe("held");
    }
  });
  it("Exhaustion holds the task", async () => {
    for (const counter of ["followups", "nonprogress"] as const) {
      const f = fixture();
      await ready(f);
      f.task[counter] = counter === "followups" ? 3 : 1;
      f.suggestion = {
        taskID: "task",
        workerID: "worker",
        action: "continue",
        nextStep: "Verify API",
        scope: ["api"],
        progress: false,
      };
      expect((await f.supervisor.supervise("task")).reason).toContain("limit");
      expect(f.sends).toHaveLength(0);
    }
    const f = fixture();
    f.port.inventory = async () =>
      Array.from({ length: 9 }, (_, i) => ({ ...f.task, id: `task-${i}` }));
    expect((await f.supervisor.reconnect("1")).reason).toContain("limit");
  });
  it("Reload preserves consumed limits", async () => {
    const f = fixture();
    f.task.followups = 3;
    const reload = new Supervisor(f.port);
    await ready(f, reload);
    expect((await reload.supervise("task")).reason).toContain("limit");
    expect(f.task.followups).toBe(3);
    expect(f.sends).toHaveLength(0);
  });
  it("Invalidates a changed decision input", async () => {
    await assertOuterSupervisionFailures();
    await assertReservationFences();
    for (const change of [
      "epoch",
      "revision",
      "worker",
      "turn",
      "sharing",
      "evidence",
      "observer",
      "authorization",
    ]) {
      const f = fixture();
      await ready(f);
      f.onSuggest = () => {
        if (change === "epoch") f.task.epoch++;
        if (change === "revision") f.task.revision++;
        if (change === "worker") f.task.workerID = "other";
        if (change === "turn") f.observation.turn++;
        if (change === "sharing") f.task.shared = [{ id: "new", version: 2 }];
        if (change === "evidence")
          f.observation.context.evidence = [
            {
              id: "different",
              kind: "tool",
              text: "Changed provenance",
              criterion: "API verified",
            },
          ];
        if (change === "observer") f.supervisor.close();
        if (change === "authorization") f.allowed = false;
      };
      expect((await f.supervisor.supervise("task")).reason).toMatch(
        /changed|disconnect/i,
      );
      expect(f.sends).toHaveLength(0);
      expect(f.task.status).not.toBe("complete");
    }
    for (const phase of ["validate", "record"] as const) {
      const native = await completionFixture("complete", "pre-idle");
      try {
        const snapshot = (await native.read()).snapshot;
        const changeInput = () => {
          const assistant = native.messages.find(
            (m) => m.type === "assistant",
          )!;
          native.messages.push({ ...assistant, id: "new-native-work" });
        };
        if (phase === "validate") {
          const generate = native.nativeHost.generate;
          native.nativeHost.generate = async (...args) => {
            const result = await generate(...args);
            changeInput();
            return result;
          };
        }
        if (phase === "record") native.afterValidation(changeInput);
        const state = await native.run();
        expect(state.completions).toEqual([]);
        expect((await native.read()).snapshot).toEqual(snapshot);
        expect((await native.backend.inspect()).bindings[0]?.status).not.toBe(
          "complete",
        );
        expect(native.calls()).toBe(phase === "validate" ? 1 : 2);
      } finally {
        await native.cleanup();
      }
    }
    const native = await observerFixture();
    await native.observer.idle({ sessionID: "worker", background: [] });
    await native.observer.dispose();
    expect((await native.read()).snapshot).toBeUndefined();
    const reloaded = await createWorkerObserver(
      native.host,
      native.home,
      native.task.location,
    );
    expect((await native.read()).snapshot).toBeUndefined();
    await reloaded.idle({ sessionID: "worker", background: [] });
    expect((await native.read()).snapshot).toBeDefined();
    await reloaded.event({
      id: "event-1",
      created: 1,
      type: "session.execution.started",
      durable: { aggregateID: "child", seq: 1, version: 1 },
      data: { sessionID: "child" },
    });
    await reloaded.idle({ sessionID: "worker", background: [] });
    await reloaded.event({
      id: "event-3",
      created: 3,
      type: "session.execution.started",
      durable: { aggregateID: "child", seq: 3, version: 1 },
      data: { sessionID: "child" },
    });
    await reloaded.idle({ sessionID: "worker", background: [] });
    expect((await native.read()).snapshot).toBeUndefined();
    await reloaded.dispose();
    await native.backend.dispose();
  });
  it("Holds an invalid evaluator result", async () => {
    await assertBoundedReservationRejections();
    for (const value of [
      null,
      { action: "delete" },
      { taskID: "other", workerID: "worker", action: "complete", support: [] },
      {
        taskID: "task",
        workerID: "worker",
        action: "continue",
        nextStep: "Verify",
        scope: ["secrets"],
        progress: true,
      },
      "throw",
      "expire",
    ]) {
      const f = fixture();
      await ready(f);
      f.suggestion = value;
      if (value === "throw")
        f.onSuggest = () => {
          throw new Error("evaluator unavailable");
        };
      if (value === "expire") {
        f.suggestion = {
          taskID: "task",
          workerID: "worker",
          action: "continue",
          nextStep: "Verify",
          scope: ["api"],
          progress: true,
        };
        f.onSuggest = () => {
          f.now = 1_201_000;
        };
      }
      expect((await f.supervisor.supervise("task")).reason).toMatch(
        /invalid|expired|scope/i,
      );
      expect(f.sends).toHaveLength(0);
    }
  });
  it("Reconciles an already admitted follow-up", async () => {
    const f = fixture();
    await ready(f);
    f.intent = pending();
    f.task.followups = 1;
    f.delivery = "admitted";
    expect((await f.supervisor.supervise("task")).status).toBe("reconciled");
    expect(f.intent?.status).toBe("admitted");
    expect(f.sends).toHaveLength(0);
    expect(f.task.followups).toBe(1);
  });
  it("Holds an ambiguous delivery", async () => {
    const failures = ["binding", "observe", "authorized"] as const;
    const unreadableReservations = [];
    for (const failure of failures) {
      const f = fixture();
      await ready(f);
      const reserve = f.port.reserve;
      f.port.reserve = async (...args) => {
        const reserved = await reserve(...args);
        f.port[failure] = async () => {
          throw new Error("Unreadable post-reservation authority");
        };
        return reserved;
      };
      const result = await f.supervisor.supervise("task");
      unreadableReservations.push({
        failure,
        result: result.status,
        intent: f.intent?.status,
      });
      expect(f.task.followups, failure).toBe(1);
      expect(f.intent?.id, failure).toBe("prompt-1");
      expect(f.sends, failure).toHaveLength(0);
      await f.supervisor.supervise("task");
      expect(f.task.followups, failure).toBe(1);
      expect(f.sends, failure).toHaveLength(0);
    }
    expect(unreadableReservations).toEqual(
      failures.map((failure) => ({
        failure,
        result: "held",
        intent: "ambiguous",
      })),
    );
    for (const mode of ["unknown", "absent", "admission", "throw"] as const) {
      const f = fixture();
      await ready(f);
      if (mode === "admission" || mode === "throw") {
        f.admission = "ambiguous";
        if (mode === "throw")
          f.onAdmit = () => {
            throw new Error("Lost acknowledgement");
          };
      } else {
        f.intent = pending();
        f.task.followups = 1;
        f.delivery = mode;
      }
      expect((await f.supervisor.supervise("task")).reason).toContain(
        "delivery",
      );
      expect(f.intent?.status).toBe("ambiguous");
      expect(f.task.followups).toBe(1);
      await f.supervisor.supervise("task");
      expect(f.sends).toHaveLength(
        mode === "admission" || mode === "throw" ? 1 : 0,
      );
    }
  });
  it("Completes against supported success criteria", async () => {
    const untagged = fixture();
    await ready(untagged);
    untagged.observation.context.evidence =
      untagged.observation.context.evidence.map((entry) => {
        const untaggedEntry = { ...entry };
        delete untaggedEntry.criterion;
        return untaggedEntry;
      });
    untagged.suggestion = {
      taskID: "task",
      workerID: "worker",
      action: "complete",
      support: [{ criterion: "API verified", evidenceID: "tool-7" }],
    };
    expect((await untagged.supervisor.supervise("task")).status).toBe(
      "complete",
    );
    expect(untagged.recordedSupport).toContainEqual([
      { criterion: "API verified", evidenceID: "tool-7" },
    ]);
    expect(untagged.sends).toHaveLength(0);
    const f = fixture();
    await ready(f);
    f.suggestion = {
      taskID: "task",
      workerID: "worker",
      action: "complete",
      support: [{ criterion: "API verified", evidenceID: "tool-7" }],
    };
    expect((await f.supervisor.supervise("task")).status).toBe("complete");
    expect(f.task.status).toBe("complete");
    expect(f.sends).toHaveLength(0);
    await f.supervisor.supervise("task");
    expect(f.contexts).toHaveLength(1);
    expect(f.recordedSupport).toContainEqual([
      { criterion: "API verified", evidenceID: "tool-7" },
    ]);
    for (const projection of ["full", "pre-idle"] as const) {
      const native = await completionFixture("complete", projection);
      const hook = (await native.read()).snapshot!;
      expect(hook.messageIDs).toHaveLength(projection === "pre-idle" ? 1 : 2);
      expect(hash(native.messages.slice(0, hook.messageIDs.length))).toBe(
        hook.contextFingerprint,
      );
      const recorded = { snapshot: await native.run() };
      if (!recorded.snapshot)
        throw new Error(
          "Current eligible coordinator must receive the completion inventory",
        );
      expect(recorded.snapshot.bindings[0]?.status).toBe("complete");
      expect(recorded.snapshot.completions[0]).toMatchObject({
        validation: {
          status: "accept",
          criteria: [
            {
              criterion: "API verified",
              evidence: [{ messageID: "assistant-7", callID: "native-call" }],
            },
          ],
        },
      });
      expect(recorded.snapshot.completions[0]).not.toHaveProperty(
        "evidence.entries",
      );
      expect(recorded.snapshot.completions[0]?.evidence).toMatchObject({
        taskID: native.task.id,
        workerID: native.task.workerID,
        turn: native.evidence.turn,
        fingerprint: hash(native.evidence),
        native: [native.entry.native],
      });
      expect(JSON.stringify(recorded.snapshot.completions)).not.toContain(
        '"command":"verify api"',
      );
      expect(JSON.stringify(recorded.snapshot.completions)).not.toContain(
        '"content":[{"type":"text","text":"API verified"}]',
      );
      const durable = {
        version: recorded.snapshot.version,
        bindings: recorded.snapshot.bindings,
        snapshots: recorded.snapshot.snapshots,
        intents: recorded.snapshot.intents,
        completions: recorded.snapshot.completions,
        supervision: recorded.snapshot.supervision,
        sessionDeliveries: recorded.snapshot.sessionDeliveries,
      };
      expect(parseCoordinatorState(durable).completions).toEqual(
        recorded.snapshot.completions,
      );
      const corrupted = structuredClone(durable);
      corrupted.completions[0]!.validation.criteria![0]!.evidence[0]!.callID =
        "unrelated-call";
      expect(() => parseCoordinatorState(corrupted)).toThrow();
      expect(native.calls()).toBe(2);
      expect((await native.read()).snapshot).toEqual(hook);
      await native.cleanup();
    }
  });
  it("Escalates unsupported completion claims", async () => {
    const invalidModes = ["no-native", "wrong-criterion"] as const;
    const invalidEvidence = [];
    for (const mode of invalidModes) {
      const f = fixture();
      await ready(f);
      f.observation.context.evidence = f.observation.context.evidence.map(
        (entry) => {
          if (mode === "wrong-criterion")
            return { ...entry, criterion: "Other criterion" };
          const withoutNative = { ...entry };
          delete withoutNative.native;
          return withoutNative;
        },
      );
      f.suggestion = {
        taskID: "task",
        workerID: "worker",
        action: "complete",
        support: [{ criterion: "API verified", evidenceID: "tool-7" }],
      };
      const result = await f.supervisor.supervise("task");
      invalidEvidence.push({ mode, status: result.status });
      expect(f.sends, mode).toHaveLength(0);
    }
    expect(invalidEvidence).toEqual(
      invalidModes.map((mode) => ({ mode, status: "held" })),
    );
    for (const mode of ["missing", "claim", "stale"]) {
      const f = fixture();
      await ready(f);
      f.suggestion = {
        taskID: "task",
        workerID: "worker",
        action: "complete",
        support: [
          {
            criterion: "API verified",
            evidenceID: mode === "missing" ? "absent" : "tool-7",
          },
        ],
      };
      if (mode === "claim")
        f.observation.context.evidence = [
          {
            id: "tool-7",
            kind: "worker",
            text: "I am done",
            criterion: "API verified",
          },
        ];
      if (mode === "stale") f.validCompletion = false;
      expect((await f.supervisor.supervise("task")).reason).toContain(
        "evidence",
      );
      expect(f.task.status).toBe("held");
      expect(f.sends).toHaveLength(0);
    }
    for (const mode of ["bad-ref", "missing", "forged", "stale"] as const) {
      const native = await completionFixture();
      if (mode === "bad-ref")
        native.validation({
          status: "accept",
          rationale: "Claim",
          criteria: [
            {
              criterion: "API verified",
              status: "accept",
              rationale: "Claim",
              evidence: [{ ...native.entry.native, callID: "unrelated" }],
            },
          ],
        });
      if (mode === "missing")
        native.validation({
          status: "accept",
          rationale: "Assistant claims success",
          criteria: [],
        });
      if (mode === "stale")
        native.afterValidation(() =>
          native.observer.event({
            id: "new-work",
            type: "session.execution.started",
            created: 3,
            durable: { aggregateID: "worker", seq: 1, version: 1 },
            data: { sessionID: "worker" },
          }),
        );
      if (mode === "forged")
        await expect(
          native.backend.nativeControl(
            "record",
            native.task.id,
            {
              result: { status: "complete", reason: "Claim" },
              receiptID: "caller-invented",
            },
            native.identity,
          ),
        ).rejects.toThrow();
      else expect((await native.run()).completions).toEqual([]);
      expect((await native.backend.inspect()).bindings[0]?.status).not.toBe(
        "complete",
      );
      expect(native.calls()).toBe(mode === "forged" ? 0 : 2);
      await native.cleanup();
    }
  });
  it("Disconnect stops future follow-ups", async () => {
    const server = fixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const suggest = server.port.suggest;
    server.port.suggest = async (input) => {
      entered();
      await blocked;
      return suggest(input);
    };
    const runtime = new ServerSupervision(server.port);
    await runtime.start(1);
    await runtime.rearm(1);
    const old = runtime.wake("worker");
    await started;
    runtime.close();
    server.port.suggest = suggest;
    await runtime.start(1);
    await runtime.rearm(1);
    const next = runtime.wake("worker");
    release();
    await Promise.all([old, next]);
    expect(server.sends).toHaveLength(1);
    runtime.close();
    const f = fixture();
    await ready(f);
    f.onAdmit = () => f.supervisor.close();
    expect((await f.supervisor.supervise("task")).reason).toContain(
      "disconnect",
    );
    expect(f.sends).toHaveLength(1);
    expect((await f.supervisor.supervise("task")).status).toBe("held");
    expect(f.sends).toHaveLength(1);
    expect(f.task.followups).toBe(1);
  });
  it("Reconnect inventories before rearming", async () => {
    const invalidGenerations = [
      "generation-1",
      "0",
      "-1",
      "1.5",
      "9007199254740992",
      "NaN",
      "Infinity",
      "",
      "1e3",
      " 1",
      "1 ",
      "0x10",
      "5.0",
      "01",
    ];
    const generationResults = [];
    for (const generation of invalidGenerations) {
      const f = fixture();
      f.port.authorized = async () => true;
      const reconnect = await f.supervisor.reconnect(generation);
      const rearm = await f.supervisor.rearm(generation);
      generationResults.push({
        generation,
        invalid: reconnect.reason.includes("invalid generation"),
        rearm: rearm.status,
      });
      expect(f.contexts, generation).toHaveLength(0);
    }
    expect(generationResults).toEqual(
      invalidGenerations.map((generation) => ({
        generation,
        invalid: true,
        rearm: "held",
      })),
    );
    for (const state of ["settled", "running"] as const) {
      const f = fixture();
      f.task.followups = 1;
      f.intent = pending();
      f.delivery = "admitted";
      f.observation = { ...f.observation, state };
      const result = await f.supervisor.reconnect("1");
      expect(result.reason).toContain("rearm");
      expect(f.reads).toEqual(["inventory", "observe", "delivery"]);
      expect(f.task.status).toBe("active");
      expect((await f.supervisor.supervise("task")).reason).toContain(
        "disconnect",
      );
      expect((await f.supervisor.rearm("1")).status).toBe("reconciled");
      expect(f.task.followups).toBe(1);
    }
    const denied = fixture();
    denied.allowed = false;
    await denied.supervisor.reconnect("1");
    expect((await denied.supervisor.rearm("1")).status).toBe("held");
  });
});
