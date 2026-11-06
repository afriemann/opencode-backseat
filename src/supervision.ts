import {
  Supervisor,
  type SupervisionPort,
  type WorkerObservation,
} from "./lifecycle.ts";
import type { SupervisionResult, DispatchIntent } from "./dispatch.ts";
import { AUTOMATION_LIMITS, SUPERVISION_BOUNDS } from "./evaluator.ts";
import {
  buildContext,
  fingerprint,
  nativeToolEvidence,
  type SharedSnapshot,
  type TaskEvidence,
} from "./context.ts";
import {
  readNativeLiveState,
  NATIVE_BOUNDS,
  type NativeClient,
  type NativeAskClient,
} from "./native-sessions.ts";
import type { WorkerBinding, WorkerSnapshot } from "./state.ts";
import type {
  CoordinatorSnapshot,
  SuggestInput,
  SuggestResult,
  ValidateInput,
} from "./rpc.ts";
import { decisionIdentity, nativeReferenceMatches } from "./context.ts";
import {
  parseStrictValidationResult,
  validatedRelationships,
  VALIDATION_BOUNDS,
  type StrictValidationResult,
  type Suggestion,
  type DecisionIdentity,
} from "./evaluator.ts";

export interface ServerPortHost {
  generation: number;
  current(): Promise<CoordinatorSnapshot>;
  authorized(binding: WorkerBinding): Promise<boolean>;
  observe(binding: WorkerBinding): Promise<WorkerObservation>;
  suggest(input: Omit<SuggestInput, "proof">): Promise<SuggestResult>;
  validate(
    input: Omit<ValidateInput, "proof">,
  ): Promise<StrictValidationResult>;
  control(
    operation: "reserve" | "finish" | "record",
    binding: WorkerBinding,
    body: unknown,
  ): Promise<boolean>;
  delivery(
    binding: WorkerBinding,
    intent: DispatchIntent,
  ): Promise<"admitted" | "unknown">;
  prompt(
    binding: WorkerBinding,
    intent: DispatchIntent,
  ): Promise<"admitted" | "ambiguous">;
}

export function createServerSupervisionPort(
  host: ServerPortHost,
): SupervisionPort {
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
      validationAttempted?: boolean;
      receipt?: StrictValidationResult;
    }
  >();
  const bounded = <T>(cache: Map<string, T>) => {
    while (cache.size > VALIDATION_BOUNDS.receipts)
      cache.delete(cache.keys().next().value!);
  };
  const binding = async (taskID: string) => {
    const value = (await host.current()).bindings.find(
      (task) => task.id === taskID,
    );
    if (!value) throw new Error("Task is unavailable");
    return value;
  };
  const observe = async (task: WorkerBinding) => {
    const observation = await host.observe(task);
    observations.set(task.id, {
      binding: structuredClone(task),
      observation: structuredClone(observation),
    });
    bounded(observations);
    return observation;
  };
  const evidenceFor = (read: WorkerObservation): TaskEvidence => ({
    taskID: read.context.task.id,
    workerID: read.context.task.workerID,
    turn: read.turn,
    entries: read.context.evidence,
  });
  const currentDecision = async (taskID: string, receiptRequired = false) => {
    const decision = decisions.get(taskID);
    if (
      !decision ||
      Date.now() < decision.decisionAt ||
      Date.now() - decision.decisionAt >= AUTOMATION_LIMITS.decisionAgeMs
    )
      throw new Error("Issued decision is unavailable or expired");
    const task = await binding(taskID);
    const read = await observe(task);
    if (
      !(await host.authorized(task)) ||
      task.status !== "active" ||
      read.state !== "settled" ||
      read.asks.length ||
      !read.snapshot ||
      fingerprint(read.context) !== fingerprint(decision.observation.context) ||
      fingerprint(
        decisionIdentity(
          task,
          host.generation,
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
  const validateDecision = async (taskID: string) => {
    try {
      const decision = await currentDecision(taskID);
      if (!decision.receipt) {
        if (decision.validationAttempted) return false;
        decision.validationAttempted = true;
        decision.receipt = parseStrictValidationResult(
          await host.validate({
            generation: host.generation,
            identity: decision.identity,
            evidence: decision.evidence,
            suggestion: decision.suggestion,
          }),
        );
      }
      await currentDecision(taskID, true);
      return true;
    } catch {
      return false;
    }
  };
  return {
    binding,
    inventory: async () =>
      (await host.current()).bindings.filter(
        (task) => task.status === "active",
      ),
    observe,
    authorized: async (generation, task) =>
      generation === String(host.generation) && (await host.authorized(task)),
    suggest: async (input) => {
      decisions.delete(input.task.id);
      const captured = observations.get(input.task.id);
      if (
        !captured?.observation.snapshot ||
        fingerprint(captured.observation.context) !== fingerprint(input)
      )
        return undefined;
      const evidence = evidenceFor(captured.observation);
      const issued = await host.suggest({
        taskID: input.task.id,
        revision: input.task.revision,
        epoch: input.task.epoch,
        generation: host.generation,
        evidence,
      });
      if (
        !issued.suggestion ||
        !issued.context ||
        fingerprint(issued.context) !== fingerprint(input) ||
        !(await host.authorized(captured.binding))
      )
        return undefined;
      decisions.set(input.task.id, {
        ...structuredClone(captured),
        evidence,
        suggestion: structuredClone(issued.suggestion),
        identity: decisionIdentity(
          captured.binding,
          host.generation,
          evidence,
          captured.observation.snapshot,
          issued.suggestion,
        ),
        decisionAt: Date.now(),
      });
      bounded(decisions);
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
      (await host.current()).intents.find(
        (entry) =>
          entry.intent.taskID === taskID && entry.intent.status !== "admitted",
      )?.intent,
    reserve: async (task, intent, fence) => {
      const decision = await currentDecision(task.id, true);
      if (fence?.() || intent.identity !== fingerprint(decision.identity))
        return false;
      return host.control("reserve", task, {
        intent,
        decisionAt: decision.decisionAt,
        receiptID: decision.receipt!.receiptID,
        identity: decision.identity,
      });
    },
    delivery: async (intent) =>
      host.delivery(await binding(intent.taskID), intent),
    admit: async (task, intent, fence) => {
      const current = await binding(task.id);
      if (
        !(await host.authorized(current)) ||
        current.workerID !== intent.workerID ||
        current.epoch !== task.epoch ||
        current.revision !== task.revision ||
        current.status !== "active"
      )
        return "ambiguous";
      const read = await observe(current);
      if (read.state !== "settled" || read.asks.length || fence?.())
        return "ambiguous";
      await currentDecision(task.id, true);
      if (fence?.()) return "ambiguous";
      return host.prompt(current, intent);
    },
    finish: async (intent, status) => {
      await host.control("finish", await binding(intent.taskID), {
        intentID: intent.id,
        status,
      });
    },
    record: async (task, result, _support, fence) => {
      if (fence?.()) return;
      if (result.status === "complete") {
        const decision = await currentDecision(task.id, true);
        if (fence?.()) return;
        await host.control("record", task, {
          result,
          receiptID: decision.receipt!.receiptID,
          identity: decision.identity,
        });
      } else await host.control("record", task, { result });
    },
    now: Date.now,
    nextPromptID: () => `msg_${crypto.randomUUID()}`,
  };
}

export type ObservationClient = NativeAskClient & {
  session: Pick<NativeClient["session"], "get" | "active" | "context"> & {
    inbox: Pick<NativeClient["session"]["inbox"], "list">;
  };
  message: Pick<NativeClient["message"], "list">;
  shell: Pick<NativeClient["shell"], "list">;
  experimental: {
    session: Pick<NativeClient["experimental"]["session"], "log">;
  };
};

/** Current full-client reads; no idle/log event can prove global settlement. */
export async function readNativeObservation(
  client: ObservationClient,
  binding: WorkerBinding,
  snapshots: readonly SharedSnapshot[],
  signal: AbortSignal,
  observed?: WorkerSnapshot,
): Promise<WorkerObservation> {
  const request = { signal };
  const [live, shells, nativeContext] = await Promise.all([
    readNativeLiveState(client, binding, signal),
    client.shell.list({ location: { directory: binding.location } }, request),
    client.session.context({ sessionID: binding.workerID }, request),
  ]);
  const { worker, active, asks, inbox } = live;
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
    // Native execution projections need both ledgers and the current worker hook.
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
  // The hook can precede only one appended successful idle marker, not new work.
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

export class ServerSupervision {
  private supervisor: Supervisor;
  private generation: number | undefined;
  private revision = 0;
  private armed = false;
  private readonly pending = new Set<string>();
  private draining: Promise<void> | undefined;
  constructor(private readonly port: SupervisionPort) {
    this.supervisor = this.createSupervisor();
  }
  private createSupervisor(): Supervisor {
    const revision = this.revision;
    return new Supervisor({
      ...this.port,
      record: async (...input) => {
        if (revision === this.revision) await this.port.record(...input);
      },
    });
  }
  async start(generation: number): Promise<SupervisionResult> {
    this.close();
    this.supervisor = this.createSupervisor();
    if (!Number.isSafeInteger(generation) || generation < 1)
      return { status: "held", reason: "Invalid server generation" };
    const revision = this.revision;
    const result = await this.supervisor.reconnect(String(generation));
    if (revision === this.revision) this.generation = generation;
    return result;
  }
  async rearm(generation: number): Promise<SupervisionResult> {
    if (generation !== this.generation)
      return { status: "held", reason: "Current server inventory is required" };
    const revision = this.revision;
    const result = await this.supervisor.rearm(String(generation));
    if (revision === this.revision) this.armed = result.status === "reconciled";
    return result;
  }
  async wake(sessionID: string, ask = false): Promise<void> {
    if (!this.armed) return;
    const revision = this.revision;
    const workers = await this.port.inventory();
    if (revision !== this.revision || !this.armed) return;
    for (const worker of workers) {
      if (worker.workerID !== sessionID) continue;
      if (ask) this.supervisor.observeAsk(worker.id);
      if (worker.status !== "active") continue;
      if (
        this.pending.size >= AUTOMATION_LIMITS.activeWorkers &&
        !this.pending.has(worker.id)
      )
        throw new Error("Server supervision queue capacity exceeded");
      this.pending.add(worker.id);
    }
    if (!this.pending.size) return;
    if (!this.draining) {
      const supervisor = this.supervisor;
      const work = Promise.resolve().then(async () => {
        while (this.armed && revision === this.revision && this.pending.size) {
          const taskID = this.pending.values().next().value!;
          this.pending.delete(taskID);
          await supervisor.supervise(taskID);
        }
      });
      this.draining = work;
      const clear = () => {
        if (this.draining === work) this.draining = undefined;
      };
      void work.then(clear, clear);
    }
    await this.draining;
  }
  close(): void {
    this.armed = false;
    this.generation = undefined;
    this.revision++;
    this.pending.clear();
    this.draining = undefined;
    this.supervisor.close();
  }
}
