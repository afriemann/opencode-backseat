import { Plugin } from "@opencode/plugin/tui";
import type { RpcClient } from "@opencode/client";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  applyNativeNoColor,
  CoordinationUI,
  coordinationStatusDetails,
  coordinatorSessionChoices,
  coordinatorHomeDetails,
  supervisionChoices,
  overview,
  sharedVersionDetails,
  type ProjectChoice,
  type WorkerChoice,
  type UiState,
} from "./ui.ts";
import { parseGoal, type WorkerBinding, type WorkerSnapshot } from "./state.ts";
import {
  ConmanRpc,
  reasoningPayload,
  type CoordinatorSnapshot,
  type ControlOperation,
  type ControlBody,
} from "./rpc.ts";
import {
  createObserverCapability,
  type ControlPayload,
  type SignedControl,
} from "./ownership.ts";
import {
  Supervisor,
  type SupervisionPort,
  type WorkerObservation,
} from "./lifecycle.ts";
import {
  buildContext,
  decisionIdentity,
  fingerprint,
  nativeReferenceMatches,
  nativeToolEvidence,
  type SharedSnapshot,
  type TaskEvidence,
} from "./context.ts";
import {
  AUTOMATION_LIMITS,
  parseStrictValidationResult,
  validatedRelationships,
  VALIDATION_BOUNDS,
  SUPERVISION_BOUNDS,
  type DecisionIdentity,
  type StrictValidationResult,
  type Suggestion,
} from "./evaluator.ts";
import type { DispatchIntent } from "./dispatch.ts";

export type NativeClient = Plugin.Context["client"];
export interface NativeCatalogClient {
  project: Pick<NativeClient["project"], "list">;
  agent: Pick<NativeClient["agent"], "list">;
  session: Pick<NativeClient["session"], "list">;
}

export interface NativeAskClient {
  permission: { request: Pick<NativeClient["permission"]["request"], "list"> };
  session: { form: Pick<NativeClient["session"]["form"], "list" | "get"> };
}

export async function readNativeAsks(
  client: NativeAskClient,
  binding: WorkerBinding,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const [permissions, forms] = await Promise.all([
    client.permission.request.list(
      { location: { directory: binding.location } },
      signal ? { signal } : undefined,
    ),
    client.session.form.list(
      { sessionID: binding.workerID },
      signal ? { signal } : undefined,
    ),
  ]);
  if (
    permissions.location.directory !== binding.location ||
    permissions.data.length > NATIVE_BOUNDS.catalogRows ||
    forms.length > NATIVE_BOUNDS.catalogRows ||
    forms.some((form) => form.sessionID !== binding.workerID)
  ) {
    throw new Error("Pending-input inventory is incomplete or mismatched");
  }
  const asks = permissions.data
    .filter((request) => request.sessionID === binding.workerID)
    .map((request) => `permission:${request.id}`);
  for (const form of forms) {
    const detail = await client.session.form.get(
      { sessionID: binding.workerID, formID: form.id },
      signal ? { signal } : undefined,
    );
    if (detail.id !== form.id || detail.sessionID !== binding.workerID)
      throw new Error("Form inventory does not match the selected worker");
    if (detail.state.status === "pending") asks.push(`form:${form.id}`);
  }
  return asks;
}

const NATIVE_BOUNDS = Object.freeze({ catalogRows: 200 });

export class NativeDiscovery {
  constructor(
    private readonly client: NativeCatalogClient,
    private readonly signal?: AbortSignal,
  ) {}
  async projects(): Promise<readonly ProjectChoice[]> {
    const projects = await this.client.project.list(
      { archived: false },
      this.signal ? { signal: this.signal } : undefined,
    );
    const choices = projects.flatMap((project) =>
      [...new Set([project.canonical, ...project.sandboxes])].map(
        (location) => ({
          id: JSON.stringify([project.id, location]),
          title:
            location === project.canonical
              ? (project.name ?? pathName(location))
              : `${project.name ?? pathName(project.canonical)} / ${pathName(location)}`,
          location,
        }),
      ),
    );
    if (
      choices.length > NATIVE_BOUNDS.catalogRows ||
      choices.some((choice) => !choice.location.startsWith("/"))
    ) {
      throw new Error("Project discovery is incomplete or unsupported");
    }
    return choices;
  }

  async agents(location: string): Promise<readonly string[]> {
    const result = await this.client.agent.list(
      { location: { directory: location } },
      this.signal ? { signal: this.signal } : undefined,
    );
    if (
      result.location.directory !== location ||
      result.data.length > NATIVE_BOUNDS.catalogRows
    ) {
      throw new Error("Agent discovery does not match the selected location");
    }
    return result.data
      .filter((agent) => !agent.hidden && agent.mode !== "subagent")
      .map((agent) => agent.id);
  }

  async workers(
    location: string,
    agent: string,
  ): Promise<readonly WorkerChoice[]> {
    const workers: WorkerChoice[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let seen = 0;
    do {
      const page = await this.client.session.list(
        { directory: location, archived: false, ...(cursor ? { cursor } : {}) },
        this.signal ? { signal: this.signal } : undefined,
      );
      seen += page.data.length;
      if (seen > NATIVE_BOUNDS.catalogRows)
        throw new Error("Worker discovery exceeds its bound");
      for (const worker of page.data) {
        if (
          worker.location.directory === location &&
          worker.agent === agent &&
          !worker.time.archived
        ) {
          workers.push({
            workerID: worker.id,
            title: worker.title ?? worker.id,
            location,
            agent,
          });
        }
      }
      cursor = page.cursor.next ?? undefined;
      if (cursor && cursors.has(cursor))
        throw new Error("Worker discovery is incomplete");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return workers;
  }
}

function pathName(location: string): string {
  return location.split("/").filter(Boolean).at(-1) ?? location;
}

export type NativeRuntimeClient = NativeCatalogClient &
  NativeAskClient & {
    session: Pick<
      NativeClient["session"],
      "get" | "create" | "active" | "prompt" | "context"
    > & { inbox: Pick<NativeClient["session"]["inbox"], "list"> };
    message: Pick<NativeClient["message"], "list">;
    shell: Pick<NativeClient["shell"], "list">;
    experimental: {
      session: Pick<NativeClient["experimental"]["session"], "log">;
    };
    event: Pick<NativeClient["event"], "subscribe">;
    rpc(definition: typeof ConmanRpc): RpcClient<typeof ConmanRpc>;
  };
export interface NativeRuntimeContext {
  location: Plugin.Context["location"];
  options: Plugin.Context["options"];
  client: NativeRuntimeClient;
  keymap: Pick<Plugin.Context["keymap"], "layer">;
  data: Pick<Plugin.Context["data"], "listen">;
  renderer: Pick<Plugin.Context["renderer"], "width">;
  ui: {
    dialog: Pick<Plugin.Context["ui"]["dialog"], "select" | "prompt" | "clear">;
    toast: Plugin.Context["ui"]["toast"];
    tabs: Pick<Plugin.Context["ui"]["tabs"], "focus">;
    router: Pick<Plugin.Context["ui"]["router"], "current" | "navigate">;
  };
}

export async function readNativeDelivery(
  client: NativeRuntimeClient,
  binding: WorkerBinding,
  intent: DispatchIntent,
  signal: AbortSignal,
): Promise<"admitted" | "unknown"> {
  if (
    binding.id !== intent.taskID ||
    binding.workerID !== intent.workerID ||
    signal.aborted
  )
    return "unknown";
  try {
    const request = { signal };
    const worker = await client.session.get(
      { sessionID: intent.workerID },
      request,
    );
    if (
      worker.id !== intent.workerID ||
      worker.agent !== binding.agent ||
      worker.location.directory !== binding.location ||
      worker.time.archived
    )
      return "unknown";
    const inbox = await client.session.inbox.list(
      { sessionID: intent.workerID },
      request,
    );
    if (
      inbox.length > NATIVE_BOUNDS.catalogRows ||
      inbox.some((item) => item.sessionID !== intent.workerID)
    )
      return "unknown";
    // Admission may still be queued. Its original ID is already durably native;
    // do not send it again merely because execution has not started.
    const queued = inbox.filter((item) => item.id === intent.id);
    if (queued.length)
      return queued.length === 1 &&
        queued[0]?.type === "user" &&
        !signal.aborted
        ? "admitted"
        : "unknown";
    const seen = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | undefined;
    let delivered = false;
    do {
      const page = await client.message.list(
        {
          sessionID: intent.workerID,
          limit: NATIVE_BOUNDS.catalogRows,
          ...(cursor ? { cursor } : { order: "asc" as const }),
        },
        request,
      );
      for (const message of page.data) {
        if (seen.has(message.id) || seen.size >= NATIVE_BOUNDS.catalogRows)
          return "unknown";
        seen.add(message.id);
        if (message.id === intent.id) {
          if (message.type !== "user") return "unknown";
          delivered = true;
        }
      }
      cursor = page.cursor.next ?? undefined;
      if (cursor && cursors.has(cursor)) return "unknown";
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return delivered && !signal.aborted ? "admitted" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Current full-client reads; no idle/log event can prove global settlement. */
export async function readNativeObservation(
  client: NativeRuntimeClient,
  binding: WorkerBinding,
  snapshots: readonly SharedSnapshot[],
  signal: AbortSignal,
  observed?: WorkerSnapshot,
): Promise<WorkerObservation> {
  const request = { signal };
  const [worker, active, asks, inbox, shells, nativeContext] =
    await Promise.all([
      client.session.get({ sessionID: binding.workerID }, request),
      client.session.active(request),
      readNativeAsks(client, binding, signal),
      client.session.inbox.list({ sessionID: binding.workerID }, request),
      client.shell.list({ location: { directory: binding.location } }, request),
      client.session.context({ sessionID: binding.workerID }, request),
    ]);
  if (
    worker.id !== binding.workerID ||
    worker.agent !== binding.agent ||
    worker.location.directory !== binding.location ||
    worker.time.archived ||
    inbox.length > NATIVE_BOUNDS.catalogRows ||
    inbox.some((item) => item.sessionID !== binding.workerID) ||
    shells.location.directory !== binding.location ||
    shells.data.length > NATIVE_BOUNDS.catalogRows
  )
    throw new Error("Unreadable or mismatched worker inventory");
  const messages: Awaited<ReturnType<NativeClient["message"]["list"]>>["data"] =
    [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.message.list(
      {
        sessionID: binding.workerID,
        limit: NATIVE_BOUNDS.catalogRows,
        ...(cursor ? { cursor } : { order: "asc" as const }),
      },
      request,
    );
    messages.push(...page.data);
    if (messages.length > NATIVE_BOUNDS.catalogRows)
      throw new Error("Message inventory exceeds its bound");
    cursor = page.cursor.next ?? undefined;
    if (cursor && cursors.has(cursor))
      throw new Error("Message inventory is incomplete");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  let turn = 0;
  let currentMessage: string | undefined;
  const executionMessages = new Set<string>();
  let executionStarted = false;
  let synced = false;
  let events = 0;
  let replayed = false;
  let lastSequence = 0;
  let terminal:
    | { sequence: number; state: "succeeded" | "failed" | "interrupted" }
    | undefined;
  for await (const event of client.experimental.session.log(
    { sessionID: binding.workerID, follow: false },
    request,
  )) {
    if (++events > NATIVE_BOUNDS.catalogRows * 5)
      throw new Error("Durable log exceeds its bound");
    if (event.type === "log.synced") {
      if (event.aggregateID !== binding.workerID)
        throw new Error("Mismatched durable log");
      synced = true;
    } else {
      replayed = true;
      if (event.durable.aggregateID !== binding.workerID)
        throw new Error("Mismatched durable provenance");
      if (lastSequence && event.durable.seq !== lastSequence + 1)
        throw new Error("Incomplete durable ordering");
      lastSequence = event.durable.seq;
      if (event.type === "session.execution.started") {
        executionStarted = true;
        terminal = undefined;
        currentMessage = undefined;
        turn = 0;
        executionMessages.clear();
      }
      if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted"
      ) {
        terminal = {
          sequence: event.durable.seq,
          state:
            event.type === "session.execution.succeeded"
              ? "succeeded"
              : event.type === "session.execution.failed"
                ? "failed"
                : "interrupted",
        };
      }
      if (event.type === "session.step.started") {
        turn = event.durable.seq;
        currentMessage = event.data.assistantMessageID;
        executionMessages.add(currentMessage);
      }
    }
  }
  if (!synced || signal.aborted) throw new Error("Incomplete durable log");
  let projectedExecution = false;
  if (!replayed) {
    // 2.2.5 SessionProjector persists time.busy from execution.started and
    // time.idle/outcome from its terminal event. Assistant IDs/times and tool
    // inputs/results are native projections, not worker-authored assertions.
    // An empty experimental replay is not itself proof: reconcile both native
    // ledgers with this current execution window and the worker hook below.
    const idle = messages.at(-1);
    const busy = worker.time.busy;
    const priorIdle = messages.findLastIndex(
      (message, index) =>
        index < messages.length - 1 && message.type === "idle",
    );
    const window = messages.slice(priorIdle + 1, -1);
    const assistants = window.filter((message) => message.type === "assistant");
    projectedExecution =
      Number.isSafeInteger(busy) &&
      busy! >= 0 &&
      Number.isSafeInteger(worker.time.idle) &&
      worker.time.idle! > busy! &&
      worker.outcome === "succeeded" &&
      idle?.type === "idle" &&
      idle.outcome === "succeeded" &&
      idle.time.created <= worker.time.idle! &&
      (priorIdle < 0 || messages[priorIdle]!.time.created < busy!) &&
      new Set(messages.map((message) => message.id)).size === messages.length &&
      messages.every(
        (message, index) =>
          Number.isSafeInteger(message.time.created) &&
          (index === 0 ||
            message.time.created >= messages[index - 1]!.time.created),
      ) &&
      window.every((message) =>
        ["user", "synthetic", "assistant"].includes(message.type),
      ) &&
      assistants.length > 0 &&
      assistants.every(
        (message) =>
          message.type === "assistant" &&
          message.agent === binding.agent &&
          message.time.created >= busy! &&
          Number.isSafeInteger(message.time.completed) &&
          message.time.completed! >= message.time.created &&
          message.time.completed! <= idle!.time.created &&
          !message.content.some(
            (part) =>
              part.type === "tool" &&
              ["running", "streaming"].includes(part.state.status),
          ) &&
          nativeContext.filter(
            (value) =>
              value.id === message.id &&
              fingerprint(value) === fingerprint(message),
          ).length === 1,
      );
    if (projectedExecution) {
      for (const message of assistants) executionMessages.add(message.id);
      currentMessage = assistants.at(-1)!.id;
      turn = assistants.at(-1)!.time.created;
    }
  }
  const current = messages.find(
    (message) => message.id === currentMessage && message.type === "assistant",
  );
  const entries: TaskEvidence["entries"][number][] = [];
  for (const message of messages.filter(
    (message) =>
      executionMessages.has(message.id) &&
      nativeContext.some(
        (value) =>
          value.id === message.id &&
          fingerprint(value) === fingerprint(message),
      ),
  )) {
    if (message.type !== "assistant" || message.agent !== binding.agent)
      continue;
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim())
        entries.push({
          id: `${message.id}:text:${entries.length}`,
          kind: "worker",
          text: part.text,
        });
      if (part.type === "tool") {
        const entry = nativeToolEvidence(message.id, part);
        if (entry) entries.push(entry);
      }
    }
  }
  if (!entries.length)
    entries.push({
      id: "native:unproven",
      kind: "worker",
      text: "No inspectable current completed-tool evidence is available.",
    });
  const context = buildContext(
    binding,
    { taskID: binding.id, workerID: binding.workerID, turn, entries },
    snapshots,
    SUPERVISION_BOUNDS.contextChars,
  );
  if (context.status !== "ready") throw new Error(context.reason);
  const idle = messages.at(-1);
  const unfinished = messages.some(
    (message) =>
      executionMessages.has(message.id) &&
      message.type === "assistant" &&
      message.content.some(
        (part) =>
          part.type === "tool" &&
          ["running", "streaming"].includes(part.state.status),
      ),
  );
  let descendantRunning = false;
  if (Object.keys(active).length > NATIVE_BOUNDS.catalogRows)
    throw new Error("Active inventory exceeds its bound");
  for (const id of Object.keys(active)) {
    if (active[id]?.type !== "running") continue;
    const seen = new Set<string>();
    let parent: string | undefined = id;
    while (parent) {
      if (seen.size >= 32 || seen.has(parent))
        throw new Error("Unreadable native ancestry");
      if (parent === binding.workerID) {
        descendantRunning = true;
        break;
      }
      seen.add(parent);
      const ancestor = await client.session.get({ sessionID: parent }, request);
      if (ancestor.id !== parent || ancestor.time.archived)
        throw new Error("Unreadable native ancestry");
      parent = ancestor.parentID;
    }
  }
  const latestWorker = await client.session.get(
    { sessionID: binding.workerID },
    request,
  );
  // The hook can precede the idle message: accept only that single appended
  // successful terminal marker, never new work or a changed context prefix.
  const prefix = observed && nativeContext.slice(0, observed.messageIDs.length);
  const suffix = observed && nativeContext.slice(observed.messageIDs.length);
  const correlated =
    !!observed &&
    observed.location === binding.location &&
    observed.sessionID === binding.workerID &&
    Number.isSafeInteger(observed.publishedAt) &&
    Date.now() >= observed.publishedAt &&
    Date.now() - observed.publishedAt < AUTOMATION_LIMITS.decisionAgeMs &&
    nativeContext.length <= NATIVE_BOUNDS.catalogRows &&
    JSON.stringify(nativeContext).length <= SUPERVISION_BOUNDS.contextChars &&
    fingerprint(prefix?.map((message) => message.id)) ===
      fingerprint(observed.messageIDs) &&
    fingerprint(prefix) === observed.contextFingerprint &&
    prefix?.at(-1)?.id === observed.nativeBoundary &&
    (suffix?.length === 0 ||
      (suffix?.length === 1 &&
        suffix[0]?.type === "idle" &&
        suffix[0].outcome === "succeeded")) &&
    !!current &&
    current.type === "assistant" &&
    current.agent === binding.agent &&
    current.time.completed !== undefined &&
    nativeContext.some(
      (message) =>
        message.id === current.id &&
        fingerprint(message) === fingerprint(current),
    ) &&
    idle?.type === "idle" &&
    idle.outcome === "succeeded" &&
    idle.time.created >= current.time.completed &&
    fingerprint(nativeContext.at(-1)) === fingerprint(idle) &&
    fingerprint(latestWorker) === fingerprint(worker) &&
    (projectedExecution ||
      (executionStarted &&
        terminal?.state === "succeeded" &&
        terminal.sequence > turn));
  const state =
    descendantRunning || inbox.length || unfinished
      ? "running"
      : idle?.type === "idle" && idle.outcome === "failed"
        ? "failed"
        : idle?.type === "idle" && idle.outcome === "interrupted"
          ? "interrupted"
          : correlated && observed?.background.length
            ? "background"
            : correlated
              ? "settled"
              : "unknown";
  return {
    turn,
    state,
    asks,
    context: context.context,
    ...(observed ? { snapshot: observed } : {}),
  };
}

export function setupNativeTui(context: NativeRuntimeContext): () => void {
  const capability = createObserverCapability(); // private key retained only by this closure
  const abort = new AbortController();
  const rpc = context.client.rpc(ConmanRpc);
  const discovery = new NativeDiscovery(context.client, abort.signal);
  let home: string | undefined;
  let snapshot: CoordinatorSnapshot | undefined;
  let generation: number | undefined;
  let coordinatorID: string | undefined;
  let sequence = 0;
  let state: UiState = "disconnected";
  let statusReason =
    "Separate native-approved attachment and explicit rearm required";
  let closed = false;
  let observationQueued = false;
  let serial = Promise.resolve();
  let signedSerial: Promise<unknown> = Promise.resolve();
  const observations = new Map<
    string,
    { binding: WorkerBinding; observation: WorkerObservation }
  >();
  const decisions = new Map<
    string,
    {
      binding: WorkerBinding;
      observation: WorkerObservation;
      evidence: TaskEvidence;
      suggestion: Suggestion;
      identity: DecisionIdentity;
      decisionAt: number;
      validationAttempted?: true;
      receipt?: StrictValidationResult;
    }
  >();
  const nativeStatus: Record<string, "needs-input" | "running"> = {};
  const notice = async (status: UiState, reason: string) => {
    if (status !== "loading") statusReason = reason;
    context.ui.toast.show({
      title: "Coordinate / search",
      message: `${status}: ${reason}`,
      variant: status === "error" ? "error" : "info",
    });
  };
  const options = async () => {
    if (closed || abort.signal.aborted)
      throw new Error("Observer disconnected");
    if (!home) {
      const location = context.location;
      if (!location?.directory?.startsWith("/"))
        throw new Error("Native TUI location is unavailable");
      const bootstrap = await rpc.inspect(
        {},
        { location, signal: abort.signal },
      );
      if (!bootstrap.home.startsWith("/") || closed)
        throw new Error("Canonical coordinator home is unavailable");
      const canonical = await realpath(bootstrap.home);
      if (
        canonical !== bootstrap.home ||
        (context.options.home !== undefined &&
          (typeof context.options.home !== "string" ||
            (await realpath(context.options.home)) !== canonical))
      )
        throw new Error(
          "Explicit home conflicts with server canonical authority",
        );
      home = canonical;
    }
    return { location: { directory: home }, signal: abort.signal };
  };
  const refresh = async () => {
    const request = await options();
    const next = await rpc.inspect({}, request);
    if (closed || next.home !== request.location.directory)
      throw new Error(
        "Canonical coordinator home does not match RPC authority",
      );
    snapshot = next;
    if (
      generation !== undefined &&
      (next.authority !== "owned" ||
        next.observer?.generation !== generation ||
        next.observer.coordinatorID !== coordinatorID ||
        next.observer.verifier !== capability.verifier)
    ) {
      supervisor.close();
      generation = undefined;
      state = "disconnected";
    }
    return next;
  };
  const isCurrent = (next: CoordinatorSnapshot) =>
    !closed &&
    generation !== undefined &&
    next.authority === "owned" &&
    next.observer?.generation === generation &&
    next.observer.coordinatorID === coordinatorID &&
    next.observer.verifier === capability.verifier;
  const performControl = async (
    operation: ControlOperation,
    taskID: string,
    body: ControlBody = {},
    expected?: WorkerBinding,
    verify?: () => Promise<void>,
    fence?: () => string | undefined,
  ) => {
    const next = await refresh();
    const request = await options();
    if (!isCurrent(next))
      throw new Error("Native-approved current observer attachment required");
    if (next.observer?.sequence !== sequence) {
      supervisor.close();
      generation = undefined;
      state = "disconnected";
      throw new Error(
        "Observer sequence is uncertain; fresh native-approved attachment required",
      );
    }
    const binding = next.bindings.find((binding) => binding.id === taskID);
    if (
      expected &&
      (!binding ||
        binding.workerID !== expected.workerID ||
        binding.revision !== expected.revision ||
        binding.epoch !== expected.epoch)
    )
      throw new Error("Task changed before control admission");
    const zero = ["create", "adopt", "detach"].includes(operation);
    await verify?.();
    if (
      fence?.() ||
      closed ||
      !isCurrent(snapshot!) ||
      snapshot?.observer?.sequence !== sequence
    )
      throw new Error("Observer changed before signed control");
    const proof = capability.sign(generation!, ++sequence, {
      operation,
      taskID,
      revision: zero ? 0 : (binding?.revision ?? 0),
      epoch: zero ? 0 : (binding?.epoch ?? 0),
      body,
    });
    const result = await rpc.control({ operation, taskID, proof }, request);
    if (
      closed ||
      result.snapshot.home !== home ||
      (!isCurrent(result.snapshot) && operation !== "detach")
    ) {
      fenceObserver();
      state = "disconnected";
      throw new Error(
        "Control acknowledgement is obsolete; reconcile before rearm",
      );
    }
    snapshot = result.snapshot;
    if (!result.accepted) throw new Error("Control was not accepted");
    return result.snapshot;
  };
  const control = (
    operation: ControlOperation,
    taskID: string,
    body: ControlBody = {},
    expected?: WorkerBinding,
    verify?: () => Promise<void>,
    fence?: () => string | undefined,
  ) => {
    const pending = signedSerial.then(() =>
      performControl(operation, taskID, body, expected, verify, fence),
    );
    signedSerial = pending.catch(() => undefined);
    return pending;
  };
  const reasoning = <T>(
    payload: ControlPayload,
    expectedGeneration: number,
    request: (proof: SignedControl) => Promise<T>,
  ): Promise<T> => {
    const pending = signedSerial.then(async () => {
      const next = await refresh();
      const current = next.bindings.find((task) => task.id === payload.taskID);
      if (
        !isCurrent(next) ||
        generation !== expectedGeneration ||
        next.observer?.sequence !== sequence ||
        current?.status !== "active" ||
        current.revision !== payload.revision ||
        current.epoch !== payload.epoch
      )
        throw new Error(
          "Current approved observer and eligible task required for reasoning",
        );
      // Signing and the complete RPC request occupy the same private queue as
      // controls. Consume this sequence even if the acknowledgement is lost.
      const proof = capability.sign(expectedGeneration, ++sequence, payload);
      return request(proof);
    });
    signedSerial = pending.catch(() => undefined);
    return pending.catch(async (error) => {
      await notice(
        "error",
        error instanceof Error ? error.message : "Native reasoning unavailable",
      );
      throw error;
    });
  };
  const observe = async (binding: WorkerBinding) => {
    const next = await refresh();
    const request = await options();
    const before = await rpc.observe(
      { taskID: binding.id, workerID: binding.workerID },
      request,
    );
    const observation = await readNativeObservation(
      context.client,
      binding,
      next.snapshots,
      abort.signal,
      before.snapshot,
    );
    const after = await rpc.observe(
      { taskID: binding.id, workerID: binding.workerID },
      request,
    );
    if (fingerprint(before) !== fingerprint(after))
      throw new Error("Worker observation invalidated during native reads");
    observations.set(binding.id, {
      binding: structuredClone(binding),
      observation: structuredClone(observation),
    });
    if (observations.size > NATIVE_BOUNDS.catalogRows)
      observations.delete(observations.keys().next().value!);
    delete nativeStatus[binding.workerID];
    if (observation.asks.length) {
      nativeStatus[binding.workerID] = "needs-input";
      supervisor.observeAsk(binding.id);
    } else if (observation.state === "running")
      nativeStatus[binding.workerID] = "running";
    return observation;
  };
  const binding = async (taskID: string) => {
    const current = (await refresh()).bindings.find(
      (value) => value.id === taskID,
    );
    if (!current) throw new Error("Task is unavailable");
    return current;
  };
  const evidenceFor = (observation: WorkerObservation): TaskEvidence => ({
    taskID: observation.context.task.id,
    workerID: observation.context.task.workerID,
    turn: observation.turn,
    entries: observation.context.evidence,
  });
  const currentDecision = async (taskID: string, receiptRequired = false) => {
    const decision = decisions.get(taskID);
    if (
      !decision ||
      !generation ||
      closed ||
      Date.now() < decision.decisionAt ||
      Date.now() - decision.decisionAt >= AUTOMATION_LIMITS.decisionAgeMs
    )
      throw new Error("Issued decision is unavailable or expired");
    const task = await binding(taskID);
    const read = await observe(task);
    if (
      !isCurrent(snapshot!) ||
      task.status !== "active" ||
      read.state !== "settled" ||
      read.asks.length ||
      !read.snapshot ||
      fingerprint(read.context) !== fingerprint(decision.observation.context) ||
      fingerprint(
        decisionIdentity(
          task,
          generation,
          evidenceFor(read),
          read.snapshot,
          decision.suggestion,
        ),
      ) !== fingerprint(decision.identity)
    )
      throw new Error("Decision native inputs changed");
    if (receiptRequired) {
      const receipt = decision.receipt;
      if (
        !receipt ||
        receipt.status !== "accept" ||
        fingerprint(receipt.identity) !== fingerprint(decision.identity)
      )
        throw new Error("Matching accepted validation receipt required");
      if (
        decision.suggestion.action === "complete" &&
        (!receipt.criteria ||
          !validatedRelationships(read.context, receipt.criteria) ||
          receipt.criteria.some((criterion) =>
            criterion.evidence.some(
              (ref) =>
                !read.snapshot!.messageIDs.includes(ref.messageID) ||
                read.context.evidence.filter((entry) =>
                  nativeReferenceMatches(ref, entry),
                ).length !== 1,
            ),
          ))
      )
        throw new Error("Native completion provenance changed");
      if (
        decision.suggestion.action !== "complete" &&
        receipt.criteria !== undefined
      )
        throw new Error("Unexpected completion criteria for follow-up");
    }
    return decision;
  };
  const validateDecision = async (taskID: string): Promise<boolean> => {
    try {
      const decision = await currentDecision(taskID);
      if (!decision.receipt) {
        if (decision.validationAttempted) return false;
        decision.validationAttempted = true;
        const input = {
          generation: decision.identity.generation,
          identity: decision.identity,
          evidence: decision.evidence,
          suggestion: decision.suggestion,
        };
        decision.receipt = parseStrictValidationResult(
          await reasoning(
            reasoningPayload("validate", input),
            input.generation,
            async (proof) => rpc.validate({ ...input, proof }, await options()),
          ),
        );
      }
      await currentDecision(taskID, true);
      return true;
    } catch {
      return false;
    }
  };
  const port: SupervisionPort = {
    binding,
    inventory: async () => (await refresh()).bindings,
    observe,
    authorized: async (id, task) => {
      const next = await refresh();
      return (
        id === String(generation) &&
        isCurrent(next) &&
        next.bindings.some(
          (current) =>
            current.id === task.id &&
            current.workerID === task.workerID &&
            current.epoch === task.epoch &&
            current.revision === task.revision,
        )
      );
    },
    suggest: async (input) => {
      decisions.delete(input.task.id);
      const captured = observations.get(input.task.id);
      if (
        !captured?.observation.snapshot ||
        !generation ||
        fingerprint(captured.observation.context) !== fingerprint(input)
      )
        return undefined;
      const evidence = evidenceFor(captured.observation);
      const issuedGeneration = generation;
      const request = {
        taskID: input.task.id,
        revision: input.task.revision,
        epoch: input.task.epoch,
        generation: issuedGeneration,
        evidence,
      };
      const issued = await reasoning(
        reasoningPayload("suggest", request),
        issuedGeneration,
        async (proof) => rpc.suggest({ ...request, proof }, await options()),
      );
      if (
        generation !== issuedGeneration ||
        !isCurrent(await refresh()) ||
        !issued.suggestion ||
        !issued.context ||
        fingerprint(issued.context) !== fingerprint(input)
      )
        return undefined;
      decisions.set(input.task.id, {
        ...structuredClone(captured),
        evidence,
        suggestion: structuredClone(issued.suggestion),
        identity: decisionIdentity(
          captured.binding,
          issuedGeneration,
          evidence,
          captured.observation.snapshot,
          issued.suggestion,
        ),
        decisionAt: Date.now(),
      });
      if (decisions.size > VALIDATION_BOUNDS.receipts)
        decisions.delete(decisions.keys().next().value!);
      return issued.suggestion;
    },
    validateStep: async (task, suggestion) =>
      fingerprint(decisions.get(task.id)?.suggestion ?? null) ===
        fingerprint(suggestion) && (await validateDecision(task.id)),
    validateCompletion: async (task, observation, support) => {
      const decision = decisions.get(task.id);
      return (
        decision?.suggestion.action === "complete" &&
        fingerprint(decision.suggestion.support) === fingerprint(support) &&
        fingerprint(decision.observation.context) ===
          fingerprint(observation.context) &&
        (await validateDecision(task.id))
      );
    },
    unresolved: async (taskID) =>
      (await refresh()).intents.find(
        (entry) =>
          entry.intent.taskID === taskID && entry.intent.status !== "admitted",
      )?.intent,
    reserve: async (task, intent, fence) => {
      const decision = await currentDecision(task.id, true);
      if (intent.identity !== fingerprint(decision.identity)) return false;
      await control(
        "reserve",
        task.id,
        {
          intent,
          decisionAt: decision.decisionAt,
          receiptID: decision.receipt!.receiptID,
          identity: decision.identity,
        },
        task,
        async () => {
          await currentDecision(task.id, true);
        },
        fence,
      );
      return true;
    },
    delivery: async (intent) => {
      const current = await binding(intent.taskID);
      const persisted = snapshot?.intents.find(
        (entry) => fingerprint(entry.intent) === fingerprint(intent),
      );
      const identity = persisted?.validation?.identity;
      if (
        current.workerID !== intent.workerID ||
        !identity ||
        identity.taskID !== current.id ||
        identity.workerID !== current.workerID ||
        identity.revision !== current.revision ||
        identity.epoch !== current.epoch
      )
        return "unknown";
      const projected = await readNativeDelivery(
        context.client,
        current,
        intent,
        abort.signal,
      );
      if (projected === "admitted") return projected;
      let events = 0;
      let delivered = false;
      let synced = false;
      for await (const event of context.client.experimental.session.log(
        { sessionID: intent.workerID, follow: false },
        { signal: abort.signal },
      )) {
        if (++events > NATIVE_BOUNDS.catalogRows * 5) return "unknown";
        if (event.type === "log.synced") {
          if (event.aggregateID !== intent.workerID) return "unknown";
          synced = true;
        } else {
          if (event.durable.aggregateID !== intent.workerID) return "unknown";
          if (
            event.type === "session.inbox.delivered" &&
            event.data.sessionID === intent.workerID &&
            event.data.inboxID === intent.id
          )
            delivered = true;
        }
      }
      return synced && delivered ? "admitted" : "unknown";
    },
    admit: async (task, intent, fence) => {
      const next = await binding(task.id);
      if (
        !isCurrent(snapshot!) ||
        next.workerID !== intent.workerID ||
        next.epoch !== task.epoch ||
        next.revision !== task.revision ||
        next.status !== "active"
      )
        return "ambiguous";
      const observation = await observe(next);
      if (closed || observation.asks.length || observation.state !== "settled")
        return "ambiguous";
      await currentDecision(task.id, true);
      if (fence?.() || closed) return "ambiguous";
      // Latest-readable checks are not atomic. No permission/form reply API is
      // involved; a failed acknowledgement is never retried.
      const result = await context.client.session.prompt(
        { sessionID: intent.workerID, id: intent.id, text: intent.text },
        { signal: abort.signal },
      );
      return result.id === intent.id && result.sessionID === intent.workerID
        ? "admitted"
        : "ambiguous";
    },
    finish: async (intent, status) => {
      await control("finish", intent.taskID, { intentID: intent.id, status });
    },
    record: async (task, result, _support, fence) => {
      if (result.status === "complete") {
        const decision = await currentDecision(task.id, true);
        await control(
          "record",
          task.id,
          {
            result,
            receiptID: decision.receipt!.receiptID,
            identity: decision.identity,
          },
          task,
          async () => {
            await currentDecision(task.id, true);
          },
          fence,
        );
      } else await control("record", task.id, { result }, task);
    },
    now: Date.now,
    nextPromptID: () => `msg_${randomUUID()}`,
  };
  const supervisor = new Supervisor(port);
  const fenceObserver = () => {
    supervisor.close();
    generation = undefined;
  };
  const ui = new CoordinationUI({
    select: (title, values) =>
      context.ui.dialog.select({ title, options: values }),
    notice,
    projects: async () => {
      await notice("loading", "Loading native project locations");
      return discovery.projects();
    },
    agents: (location) => discovery.agents(location),
    workers: async (location, agent) =>
      (await discovery.workers(location, agent)).filter(
        (worker) => worker.workerID !== coordinatorID,
      ),
    open: (workerID) => !closed && context.ui.tabs.focus(workerID),
    control: async (action, task) => {
      let body: ControlBody = {};
      let resumedObservation: WorkerObservation | undefined;
      if (action === "share") {
        const raw = await context.ui.dialog.prompt({
          title: "Share explicit immutable snapshot",
          description:
            "JSON: {snapshot?: {id,version,group,content,recipients}, shared: [{id,version}]}",
        });
        if (!raw) throw new Error("Share cancelled");
        body = JSON.parse(raw) as ControlBody;
      }
      let verify: (() => Promise<void>) | undefined;
      if (action === "resume") {
        const read = await observe(task);
        if (
          !generation ||
          !isCurrent(snapshot!) ||
          read.state !== "settled" ||
          read.asks.length ||
          !read.snapshot
        )
          throw new Error(
            `Resume requires full current native reconciliation: ${read.asks.length ? "pending human input" : read.state}`,
          );
        const reconciliation = {
          generation,
          workerID: task.workerID,
          revision: task.revision,
          epoch: task.epoch,
          snapshotFingerprint: fingerprint(read.snapshot),
          observedAt: Date.now(),
          state: "settled" as const,
          asks: [] as const,
        };
        body = { reconciliation };
        resumedObservation = read;
        verify = async () => {
          const fresh = await observe(task);
          if (
            generation !== reconciliation.generation ||
            !isCurrent(snapshot!) ||
            fresh.state !== "settled" ||
            fresh.asks.length ||
            !fresh.snapshot ||
            fingerprint(fresh.snapshot) !==
              reconciliation.snapshotFingerprint ||
            fingerprint(fresh.context) !== fingerprint(read.context)
          )
            throw new Error(
              "Native resume reconciliation changed before approval",
            );
        };
      }
      const next = await control(action, task.id, body, task, verify);
      const current = next.bindings.find((value) => value.id === task.id);
      if (!current) throw new Error("Task is unavailable after control");
      if (resumedObservation) {
        let reconciled = false;
        try {
          const read = await observe(current);
          reconciled =
            read.state === "settled" &&
            !read.asks.length &&
            !!read.snapshot &&
            fingerprint(read.snapshot) ===
              fingerprint(resumedObservation.snapshot) &&
            fingerprint(read.context.evidence) ===
              fingerprint(resumedObservation.context.evidence) &&
            fingerprint(read.context.shared) ===
              fingerprint(resumedObservation.context.shared);
        } catch {
          /* An unreadable post-approval state cannot rearm automation. */
        }
        if (!reconciled) {
          supervisor.close();
          state = "awaiting-rearm";
          await control(
            "record",
            current.id,
            {
              result: {
                status: "held",
                reason: "Native resume reconciliation changed after approval",
              },
            },
            current,
          );
          throw new Error(
            "Native resume reconciliation changed after approval; explicit rearm required",
          );
        }
      }
      return current;
    },
  });
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const pending = serial.then(async () => {
      if (closed) return;
      try {
        await work();
      } catch (error) {
        if (!closed) {
          if (state === "loading") state = "error";
          await notice(
            "error",
            error instanceof Error
              ? error.message
              : "Native coordination unavailable",
          );
        }
      }
    });
    serial = pending;
    return pending;
  };
  const selectedTask = async (workerID?: string) => {
    const next = await refresh();
    const selected =
      workerID ??
      (await context.ui.dialog.select({
        title: "Worker action",
        options: overview(next.bindings, "ready").options,
      }));
    return next.bindings.find((task) => task.workerID === selected);
  };
  const showVersions = async (workerID?: string) => {
    const task = await selectedTask(workerID);
    if (task)
      await context.ui.dialog.select(
        sharedVersionDetails(task, context.renderer.width),
      );
  };
  const showStatus = async () => {
    try {
      await refresh();
    } catch (error) {
      fenceObserver();
      state = "error";
      statusReason =
        error instanceof Error ? error.message : "Inventory unavailable";
    }
    await context.ui.dialog.select(
      coordinationStatusDetails(
        snapshot?.bindings ?? [],
        state,
        [snapshot?.reason, statusReason].filter(Boolean).join("; "),
        context.renderer.width,
        nativeStatus,
      ),
    );
  };
  const selectTarget = async (kind: "create" | "adopt") => {
    if (!isCurrent(await refresh()))
      throw new Error("Native-approved observer attachment required");
    const target = await ui.selectTarget(kind);
    if (!target) return;
    if (target.workerID === coordinatorID)
      throw new Error("Coordinator session cannot be adopted as a worker");
    const raw = await context.ui.dialog.prompt({
      title: "Explicit task scope",
      description:
        "JSON: {id,title,goal,criteria,constraints,scope,group?}; selected location and agent are fixed",
    });
    if (!raw) return;
    const goal = parseGoal({
      ...JSON.parse(raw),
      location: target.location,
      agent: target.agent,
    });
    await control(
      kind,
      goal.id,
      kind === "create" ? goal : { goal, workerID: target.workerID },
    );
    await notice(
      "ready",
      "Task operation approved and recorded by native server",
    );
  };
  const currentCoordinator = async () => {
    const next = await refresh();
    const route = context.ui.router.current();
    if (
      route.type !== "session" ||
      next.bindings.some((task) => task.workerID === route.sessionID)
    )
      throw new Error("Open the canonical coordinator session, not a worker");
    const session = await context.client.session.get(
      { sessionID: route.sessionID },
      { signal: abort.signal },
    );
    if (
      session.id !== route.sessionID ||
      (await realpath(session.location.directory)) !== home ||
      session.time.archived
    )
      throw new Error("Coordinator session is not at canonical home");
    return session.id;
  };
  const attach = async () => {
    supervisor.close();
    generation = undefined;
    state = "loading";
    coordinatorID = await currentCoordinator();
    const result = await rpc.attach(
      { coordinatorID, verifier: capability.verifier },
      await options(),
    );
    if (closed) return;
    generation = result.generation;
    sequence = 0;
    if (!isCurrent(await refresh())) {
      generation = undefined;
      throw new Error("Native server observer generation did not attach");
    }
    sequence = snapshot!.observer!.sequence;
    const reconciled = await supervisor.reconnect(String(generation));
    state = "awaiting-rearm";
    await notice(state, reconciled.reason);
  };
  const rearm = async () => {
    if (!generation || !isCurrent(await refresh()))
      throw new Error("Approved current observer required");
    const result = await supervisor.rearm(String(generation));
    state = result.status === "reconciled" ? "ready" : "awaiting-rearm";
    await notice(state, result.reason);
  };
  let createdCoordinator: string | undefined;
  let creationUncertain = false;
  const usableCoordinator = async (id: string, next: CoordinatorSnapshot) => {
    if (next.bindings.some((task) => task.workerID === id)) return false;
    const session = await context.client.session.get(
      { sessionID: id },
      { signal: abort.signal },
    );
    return (
      session.id === id &&
      !session.time.archived &&
      (await realpath(session.location.directory)) === home
    );
  };
  const getStarted = async () => {
    const next = await refresh();
    if (next.authority !== "owned")
      throw new Error(next.reason ?? "Coordinator ownership unavailable");
    if (state === "ready" && isCurrent(next)) {
      await notice("ready", "Supervision is already ready");
      return;
    }
    if (!isCurrent(next)) {
      const route = context.ui.router.current();
      let candidate: string | undefined;
      if (route.type === "session") {
        try {
          if (await usableCoordinator(route.sessionID, next))
            candidate = route.sessionID;
        } catch {
          await notice(
            "disconnected",
            "Current session is unavailable; choose a coordinator explicitly",
          );
        }
      }
      if (
        !candidate &&
        createdCoordinator &&
        (await usableCoordinator(createdCoordinator, next))
      )
        candidate = createdCoordinator;
      if (!candidate && creationUncertain)
        throw new Error(
          "Session creation outcome is unknown. Open the created coordinator session, then choose Get started; no automatic retry was made.",
        );
      let selected: string | undefined;
      do {
        selected = await context.ui.dialog.select(
          coordinatorSessionChoices(home!, !!candidate),
        );
        if (selected === "home" && !closed)
          await context.ui.dialog.select(
            coordinatorHomeDetails(home!, context.renderer.width),
          );
      } while (selected === "home" && !closed);
      if (closed || abort.signal.aborted) return;
      if (selected !== "reuse" && selected !== "create") {
        await notice(
          "disconnected",
          "Setup cancelled; no attachment or arming was requested",
        );
        return;
      }
      if (selected === "reuse" && !candidate)
        throw new Error("Verified coordinator session required");
      if (selected === "create") {
        if (candidate || creationUncertain)
          throw new Error(
            "Reconcile the existing coordinator session before creating another",
          );
        await notice("loading", "Creating blank coordinator session");
        creationUncertain = true;
        const created = await context.client.session.create(
          { title: "Coordinator", location: { directory: home! } },
          { signal: abort.signal },
        );
        createdCoordinator = created.id;
        candidate = created.id;
      }
      if (
        closed ||
        !candidate ||
        !(await usableCoordinator(candidate, await refresh()))
      )
        throw new Error(
          "Created coordinator could not be verified; supervision remains stopped",
        );
      creationUncertain = false;
      const current = context.ui.router.current();
      if (current.type !== "session" || current.sessionID !== candidate)
        context.ui.router.navigate({ type: "session", sessionID: candidate });
      if (closed || (await currentCoordinator()) !== candidate)
        throw new Error(
          "Coordinator navigation was not confirmed; supervision remains stopped",
        );
      await attach();
    }
    if (closed || !isCurrent(await refresh())) return;
    const selected = await context.ui.dialog.select(supervisionChoices());
    if (closed || abort.signal.aborted) return;
    if (selected === "start") await rearm();
    else
      await notice(
        "awaiting-rearm",
        "Connected; supervision remains stopped. Choose Get started to start later.",
      );
  };
  const showOverview = async () => {
    await notice("loading", "Reading current native worker inventory");
    let next: CoordinatorSnapshot;
    try {
      next = await refresh();
    } catch (error) {
      fenceObserver();
      state = "error";
      await notice(
        state,
        error instanceof Error ? error.message : "Inventory unavailable",
      );
      await showStatus();
      return;
    }
    for (const task of next.bindings) {
      try {
        await observe(task);
      } catch (error) {
        fenceObserver();
        state = "error";
        statusReason =
          error instanceof Error
            ? error.message
            : "Worker inventory unavailable";
      }
    }
    const view = overview(
      next.bindings,
      state,
      undefined,
      context.renderer.width,
      nativeStatus,
    );
    const actions: Array<
      NonNullable<
        Parameters<Plugin.Context["ui"]["dialog"]["select"]>[0]["actions"]
      >[number]
    > = [
      {
        bind: "alt+i",
        title: "Status",
        selection: "none",
        onTrigger: () => {
          context.ui.dialog.clear();
          void enqueue(showStatus);
        },
      },
      {
        bind: "alt+v",
        title: "Versions",
        onTrigger: (workerID) => {
          context.ui.dialog.clear();
          void enqueue(() => showVersions(String(workerID)));
        },
      },
      {
        bind: "alt+o",
        title: "Open",
        onTrigger: (workerID) => {
          context.ui.dialog.clear();
          void enqueue(() => workerAction("open")(String(workerID)));
        },
      },
    ];
    if (isCurrent(next)) {
      actions.push(
        {
          bind: "alt+c",
          title: "Create",
          selection: "none",
          onTrigger: () => {
            context.ui.dialog.clear();
            void enqueue(() => selectTarget("create"));
          },
        },
        {
          bind: "alt+a",
          title: "Adopt",
          selection: "none",
          onTrigger: () => {
            context.ui.dialog.clear();
            void enqueue(() => selectTarget("adopt"));
          },
        },
      );
      for (const [action, bind] of [
        ["share", "alt+s"],
        ["hold", "alt+h"],
        ["resume", "alt+r"],
        ["takeover", "alt+t"],
      ] as const) {
        actions.push({
          bind,
          title: action === "takeover" ? "Manual" : action,
          onTrigger: (workerID) => {
            context.ui.dialog.clear();
            void enqueue(() => workerAction(action)(String(workerID)));
          },
        });
      }
    }
    const selected = await context.ui.dialog.select({
      ...view,
      options: [
        ...(state !== "ready"
          ? [
              {
                title: "Get started",
                value: "conman:get-started",
                category: isCurrent(next)
                  ? "Setup: connected, stopped"
                  : "Setup: unattached",
                description:
                  "Connect a coordinator, approve attachment, then choose whether to start supervision",
              },
            ]
          : []),
        ...view.options.map((option) =>
          !next.bindings.length && state !== "ready"
            ? {
                ...option,
                title: "No workers available",
                value: "conman:status",
                disabled: false,
                description: "Inspect status without creating workers",
              }
            : {
                ...option,
                description: [option.description, next.reason]
                  .filter(Boolean)
                  .join("; "),
              },
        ),
      ],
      actions,
    });
    if (selected === "conman:get-started") await getStarted();
    else if (selected === "conman:status") await showStatus();
    else if (selected) {
      const task = next.bindings.find((task) => task.workerID === selected);
      if (task) await ui.open(task);
    }
  };
  const workerAction =
    (action: "open" | "hold" | "resume" | "takeover" | "share") =>
    async (workerID?: string) => {
      const task = await selectedTask(workerID);
      if (!task) return;
      if (action === "open") await ui.open(task);
      else await ui.control(action, task);
    };
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "conman.overview",
        title: "Coordinate / search",
        group: "Coordination",
        palette: true,
        slash: { name: "coordinate" },
        run: () => enqueue(showOverview),
      },
      {
        id: "conman.start",
        title: "Coordinate: Get started",
        group: "Coordination",
        palette: true,
        enabled: () => !closed,
        run: () => enqueue(getStarted),
      },
      {
        id: "conman.status",
        title: "Coordinate: inspect status and identities (read only)",
        group: "Coordination",
        palette: true,
        enabled: () => !closed,
        run: () => enqueue(showStatus),
      },
      {
        id: "conman.versions",
        title: "Coordinate: inspect full shared versions (read only)",
        group: "Coordination",
        palette: true,
        enabled: () => !closed,
        run: (workerID?: string) => enqueue(() => showVersions(workerID)),
      },
      {
        id: "conman.attach",
        title: "Coordinate: attach observer (native approval)",
        group: "Coordination",
        palette: true,
        enabled: () => !closed,
        run: () => enqueue(attach),
      },
      {
        id: "conman.rearm",
        title: "Coordinate: explicitly rearm reconciled observer",
        group: "Coordination",
        palette: true,
        enabled: () => !!snapshot && isCurrent(snapshot),
        run: () => enqueue(rearm),
      },
      {
        id: "conman.create",
        title: "Coordinate: create worker",
        group: "Coordination",
        palette: true,
        enabled: () => !!snapshot && isCurrent(snapshot),
        run: () => enqueue(() => selectTarget("create")),
      },
      {
        id: "conman.adopt",
        title: "Coordinate: adopt worker",
        group: "Coordination",
        palette: true,
        enabled: () => !!snapshot && isCurrent(snapshot),
        run: () => enqueue(() => selectTarget("adopt")),
      },
      ...(["open", "hold", "resume", "takeover", "share"] as const).map(
        (action) => ({
          id: `conman.${action}`,
          title: `Coordinate: ${action} worker`,
          group: "Coordination",
          palette: true as const,
          enabled: () =>
            action === "open" ? !closed : !!snapshot && isCurrent(snapshot),
          run: (workerID?: string) =>
            enqueue(() => workerAction(action)(workerID)),
        }),
      ),
      {
        id: "conman.detach",
        title: "Coordinate: detach observer",
        group: "Coordination",
        palette: true,
        run: () =>
          enqueue(async () => {
            if (!coordinatorID) return;
            await control("detach", coordinatorID);
            supervisor.close();
            generation = undefined;
            state = "disconnected";
          }),
      },
      {
        id: "conman.recover",
        title: "Coordinate: recover held coordinator (native approval)",
        group: "Coordination",
        palette: true,
        run: () =>
          enqueue(async () => {
            supervisor.close();
            generation = undefined;
            state = "disconnected";
            const recovered = await rpc.recover(
              { coordinatorID: await currentCoordinator() },
              await options(),
            );
            if (recovered.home !== home)
              throw new Error(
                "Recovery snapshot does not match canonical home",
              );
            snapshot = recovered;
            await notice(
              state,
              "Recovery requires a separate approved attachment and explicit rearm",
            );
          }),
      },
    ],
  }));
  const onEvent = (
    event: Parameters<
      Parameters<Plugin.Context["data"]["listen"]>[0]
    >[0]["details"],
  ) => {
    if (closed) return;
    if (event.type === "permission.asked" || event.type === "form.created") {
      const sessionID =
        event.type === "form.created"
          ? event.data.form.sessionID
          : event.data.sessionID;
      const task = snapshot?.bindings.find(
        (task) => task.workerID === sessionID,
      );
      if (task) {
        nativeStatus[task.workerID] = "needs-input";
        supervisor.observeAsk(task.id);
      }
    }
    if (event.type === "server.connected") {
      supervisor.close();
      generation = undefined;
      state = "disconnected";
      void enqueue(async () => {
        await refresh();
        await notice(
          "disconnected",
          "Fresh inventory available; separate attachment and explicit rearm required",
        );
      });
    } else if (
      state === "ready" &&
      event.type.startsWith("session.") &&
      !observationQueued
    ) {
      observationQueued = true;
      void enqueue(async () => {
        try {
          for (const task of (await refresh()).bindings)
            if (task.status === "active") await supervisor.supervise(task.id);
        } finally {
          observationQueued = false;
        }
      });
    }
  };
  const unlisten = context.data.listen((event) => {
    if (event.details.type === "server.connected") onEvent(event.details);
  });
  void (async () => {
    try {
      for await (const event of context.client.event.subscribe({
        signal: abort.signal,
        types: [
          "permission.asked",
          "form.created",
          "session.idle",
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
          "session.agent.selected",
          "session.moved",
          "session.inbox.delivered",
        ],
      }))
        onEvent(event);
      if (!closed) {
        supervisor.close();
        generation = undefined;
        state = "disconnected";
        await notice(
          state,
          "Native event connection ended; inventory and rearm required",
        );
      }
    } catch (error) {
      if (!closed) {
        supervisor.close();
        generation = undefined;
        state = "disconnected";
        await notice(
          state,
          error instanceof Error
            ? error.message
            : "Native event connection failed",
        );
      }
    }
  })();
  return () => {
    closed = true;
    fenceObserver();
    state = "disconnected";
    observations.clear();
    decisions.clear();
    for (const workerID of Object.keys(nativeStatus))
      delete nativeStatus[workerID];
    abort.abort();
    unlisten();
  };
}

export default Plugin.define({
  id: "conman",
  setup(context) {
    const restore = applyNativeNoColor(context.renderer);
    try {
      const close = setupNativeTui(context);
      return () => {
        close();
        restore();
      };
    } catch (error) {
      restore();
      throw error;
    }
  },
});
