import {
  decisionIdentity as nativeDecisionIdentity,
  fingerprint,
  type EvaluationContext,
} from "./context.ts";
import type { WorkerBinding, WorkerSnapshot } from "./state.ts";
import type {
  CriterionSupport,
  EvaluatorPort,
  Suggestion,
} from "./evaluator.ts";
import {
  AUTOMATION_LIMITS,
  evaluate,
  type AutomationLimits,
} from "./evaluator.ts";
import type { DispatchPort, SupervisionResult } from "./dispatch.ts";
import { dispatchFollowup, followupText, reconcileIntent } from "./dispatch.ts";

export interface WorkerObservation {
  turn: number;
  // Settled means positively proven globally settled from current native reads;
  // running/background mean known unfinished work. Unproven background is unknown.
  state:
    | "settled"
    | "running"
    | "background"
    | "unknown"
    | "failed"
    | "interrupted"
    | "unreadable";
  asks: readonly string[];
  context: EvaluationContext;
  snapshot?: WorkerSnapshot;
}
export interface SupervisionPort extends DispatchPort, EvaluatorPort {
  binding(taskID: string): Promise<WorkerBinding>;
  inventory(): Promise<readonly WorkerBinding[]>;
  observe(binding: WorkerBinding): Promise<WorkerObservation>;
  // Verify the approved generation and exact binding, not a caller's assertion.
  authorized(generation: string, binding: WorkerBinding): Promise<boolean>;
  // Full native reads plus semantic scope/non-consent admission validation.
  validateStep(
    binding: WorkerBinding,
    suggestion: Extract<Suggestion, { nextStep: string }>,
  ): Promise<boolean>;
  validateCompletion(
    binding: WorkerBinding,
    observation: WorkerObservation,
    support: readonly CriterionSupport[],
  ): Promise<boolean>;
  now(): number;
}
export class Supervisor {
  private generation: string | undefined;
  private inventoried: string | undefined;
  private connectionRevision = 0;
  private readonly asks = new Map<string, number>();
  private readonly busy = new Set<string>();
  // Non-default finite limits must come from explicitly approved server state.
  private readonly limits: Readonly<AutomationLimits>;
  constructor(
    private readonly port: SupervisionPort,
    limits: AutomationLimits = AUTOMATION_LIMITS,
  ) {
    if (
      !(Object.keys(AUTOMATION_LIMITS) as (keyof AutomationLimits)[]).every(
        (key) => Number.isSafeInteger(limits[key]) && limits[key] > 0,
      )
    )
      throw new Error("Automation limits must be finite positive integers");
    this.limits = Object.freeze({ ...limits });
  }
  close(): void {
    this.generation = undefined;
    this.inventoried = undefined;
    this.connectionRevision++;
  }
  observeAsk(taskID: string): void {
    if (this.busy.has(taskID))
      this.asks.set(taskID, (this.asks.get(taskID) ?? 0) + 1);
  }
  async reconnect(generation: string): Promise<SupervisionResult> {
    this.close();
    const revision = this.connectionRevision;
    try {
      const workers = await this.port.inventory();
      if (
        !validGeneration(generation) ||
        workers.filter((worker) => worker.status === "active").length >
          this.limits.activeWorkers
      ) {
        return {
          status: "held",
          reason: "Active worker limit exceeded or invalid generation",
        };
      }
      for (const binding of workers) {
        if (!(await this.port.authorized(generation, binding)))
          return { status: "held", reason: "Unapproved observer generation" };
        const observation = await this.port.observe(binding);
        const pending = await this.port.unresolved(binding.id);
        if (pending) await reconcileIntent(binding, pending, this.port);
        const reason = observationIssue(observation);
        if (reason) await this.hold(binding, reason);
      }
      if (revision !== this.connectionRevision)
        return {
          status: "held",
          reason: "Observer disconnected during inventory",
        };
      this.inventoried = generation;
      return {
        status: "held",
        reason: "Inventory reconciled; explicit rearm required",
      };
    } catch {
      return { status: "held", reason: "Unreadable reconnect inventory" };
    }
  }
  async rearm(generation: string): Promise<SupervisionResult> {
    const revision = this.connectionRevision;
    if (!validGeneration(generation) || this.inventoried !== generation)
      return {
        status: "held",
        reason: "Reconnect inventory required before rearm",
      };
    try {
      const workers = await this.port.inventory();
      if (
        workers.filter((worker) => worker.status === "active").length >
        this.limits.activeWorkers
      )
        return { status: "held", reason: "Active worker limit exceeded" };
      for (const binding of workers) {
        if (!(await this.port.authorized(generation, binding)))
          return { status: "held", reason: "Unapproved observer generation" };
        const observation = await this.port.observe(binding);
        const pending = await this.port.unresolved(binding.id);
        if (pending) await reconcileIntent(binding, pending, this.port);
        const reason = observationIssue(observation);
        if (reason) await this.hold(binding, reason);
      }
      if (revision !== this.connectionRevision)
        return { status: "held", reason: "Observer disconnected during rearm" };
      this.generation = generation;
      return {
        status: "reconciled",
        reason: "Inventoried observer explicitly rearmed",
      };
    } catch {
      return { status: "held", reason: "Unreadable rearm inventory" };
    }
  }
  async supervise(taskID: string): Promise<SupervisionResult> {
    if (!this.generation)
      return { status: "held", reason: "Observer disconnected or not rearmed" };
    if (this.busy.has(taskID))
      return {
        status: "deferred",
        reason: "Task evaluation already in progress",
      };
    if (this.busy.size >= this.limits.activeWorkers)
      return { status: "deferred", reason: "Active evaluation limit occupied" };
    this.busy.add(taskID);
    let binding: WorkerBinding | undefined;
    try {
      binding = await this.port.binding(taskID);
      if (binding.id !== taskID)
        return { status: "held", reason: "Invalid task binding target" };
      const generation = this.generation;
      if (!generation || !(await this.port.authorized(generation, binding)))
        return this.hold(
          binding,
          "Observer authorization changed or disconnected",
        );
      const pending = await this.port.unresolved(taskID);
      if (pending) return await reconcileIntent(binding, pending, this.port);
      if (binding.status !== "active")
        return { status: "held", reason: `Task is ${binding.status}` };
      const observation = await this.port.observe(binding);
      if (observation.asks.length)
        return this.hold(binding, "Pending human input");
      if (observation.state === "running" || observation.state === "background")
        return {
          status: "deferred",
          reason: `Worker state ${observation.state} is unfinished`,
        };
      if (observation.state !== "settled")
        return this.hold(
          binding,
          `Worker state ${observation.state} cannot establish settlement`,
        );
      if (!matchesContext(binding, observation))
        return this.hold(binding, "Changed or invalid observation context");
      if (this.asks.get(taskID))
        return this.hold(
          binding,
          "Observed human input invalidates evaluation",
        );
      const started = this.port.now();
      const askVersion = this.asks.get(taskID) ?? 0;
      const revision = this.connectionRevision;
      const identity = observationIdentity(binding, observation, generation);
      const evaluatedBinding = binding;
      const fence = (): string | undefined => {
        if (
          this.generation !== generation ||
          revision !== this.connectionRevision
        )
          return "Observer disconnected or generation changed";
        if ((this.asks.get(taskID) ?? 0) !== askVersion)
          return "Observed human input invalidates evaluation";
        const now = this.port.now();
        if (
          !Number.isSafeInteger(now) ||
          !Number.isSafeInteger(started) ||
          now - started >= this.limits.decisionAgeMs ||
          now < started
        )
          return "Decision expired or invalid clock";
        return undefined;
      };
      const current = async (
        afterAdmission = false,
      ): Promise<string | undefined> => {
        const reason = fence();
        if (reason) return reason;
        const latest = await this.port.binding(taskID);
        if (!(await this.port.authorized(generation, latest)))
          return "Observer authorization changed";
        const read = await this.port.observe(latest);
        if (read.asks.length || (this.asks.get(taskID) ?? 0) !== askVersion)
          return "Pending human input invalidates evaluation";
        const finalFence = fence();
        if (finalFence) return finalFence;
        if (
          latest.id !== taskID ||
          latest.status !== "active" ||
          latest.epoch !== evaluatedBinding.epoch ||
          latest.revision !== evaluatedBinding.revision ||
          latest.workerID !== evaluatedBinding.workerID
        )
          return "Decision input changed";
        // Successful admission itself can start another turn. It must not be
        // mistaken for a stale pre-admission decision or an ambiguous delivery.
        if (
          !afterAdmission &&
          (read.state !== "settled" ||
            !matchesContext(latest, read) ||
            observationIdentity(latest, read, generation) !== identity)
        )
          return "Decision input changed";
        return undefined;
      };
      const suggestion = await evaluate(observation.context, this.port);
      let reason = await current();
      if (reason) return this.hold(binding, reason);
      if (!suggestion)
        return this.hold(binding, "Invalid evaluator result or scope");
      if (suggestion.action === "complete") {
        if (
          !supportsCriteria(binding, observation, suggestion.support) ||
          !(await this.port.validateCompletion(
            binding,
            observation,
            suggestion.support,
          ))
        )
          return this.hold(
            binding,
            "Missing current inspectable criterion evidence",
          );
        reason = await current();
        if (reason) return this.hold(binding, reason);
        const result: SupervisionResult = {
          status: "complete",
          reason: "Approved criteria supported by current inspectable evidence",
        };
        await this.port.record(binding, result, suggestion.support, fence);
        return result;
      }
      if (unsafeStep(suggestion.nextStep))
        return this.hold(
          binding,
          "Proposed consent or human-input response is forbidden",
        );
      if (!(await this.port.validateStep(binding, suggestion)))
        return this.hold(
          binding,
          "Next step violates approved scope or non-consent policy",
        );
      const nonprogress = suggestion.progress ? 0 : binding.nonprogress + 1;
      if (
        !Number.isSafeInteger(binding.followups) ||
        binding.followups < 0 ||
        !Number.isSafeInteger(binding.nonprogress) ||
        binding.nonprogress < 0 ||
        binding.followups >= this.limits.followups ||
        nonprogress >= this.limits.nonprogress
      )
        return this.hold(
          binding,
          "Automatic follow-up or nonprogress limit exhausted",
        );
      return await dispatchFollowup(
        binding,
        {
          id: this.port.nextPromptID(),
          taskID,
          workerID: binding.workerID,
          identity: observation.snapshot
            ? fingerprint(
                nativeDecisionIdentity(
                  binding,
                  Number(generation),
                  {
                    taskID,
                    workerID: binding.workerID,
                    turn: observation.turn,
                    entries: observation.context.evidence,
                  },
                  observation.snapshot,
                  suggestion,
                ),
              )
            : identity,
          text: followupText(binding, suggestion.nextStep),
          nonprogress,
          status: "reserved",
        },
        this.port,
        { current, fence, afterAdmission: () => current(true) },
      );
    } catch {
      if (binding)
        return await this.hold(
          binding,
          "Unreadable supervision or uncertain delivery; human reconciliation required",
        );
      return { status: "held", reason: "Unreadable task binding" };
    } finally {
      this.busy.delete(taskID);
      this.asks.delete(taskID);
    }
  }
  private async hold(
    binding: WorkerBinding,
    reason: string,
  ): Promise<SupervisionResult> {
    const result: SupervisionResult = { status: "held", reason };
    try {
      await this.port.record(binding, result);
      return result;
    } catch {
      return { status: "held", reason: `Could not persist hold: ${reason}` };
    }
  }
}

function validGeneration(generation: string): boolean {
  return (
    /^[1-9]\d*$/.test(generation) && Number.isSafeInteger(Number(generation))
  );
}

function observationIssue(observation: WorkerObservation): string | undefined {
  if (observation.asks.length) return "Pending human input";
  if (
    observation.state !== "settled" &&
    observation.state !== "running" &&
    observation.state !== "background"
  )
    return `Worker state ${observation.state}`;
  return undefined;
}

function observationIdentity(
  binding: WorkerBinding,
  observation: WorkerObservation,
  generation: string,
): string {
  return fingerprint([
    binding.id,
    binding.workerID,
    binding.epoch,
    binding.revision,
    observation.turn,
    binding.agent,
    binding.location,
    binding.goal,
    binding.criteria,
    binding.constraints,
    binding.scope,
    binding.shared ?? [],
    generation,
    observation.context.evidence,
    observation.context.shared,
    observation.snapshot,
  ]);
}
function matchesContext(
  binding: WorkerBinding,
  observation: WorkerObservation,
): boolean {
  const context = observation.context;
  const expected = {
    id: binding.id,
    goal: binding.goal,
    criteria: binding.criteria,
    constraints: binding.constraints,
    scope: binding.scope,
    workerID: binding.workerID,
    agent: binding.agent,
    location: binding.location,
    revision: binding.revision,
    epoch: binding.epoch,
  };
  return (
    Number.isSafeInteger(observation.turn) &&
    observation.turn >= 0 &&
    context.turn === observation.turn &&
    JSON.stringify(context.task) === JSON.stringify(expected) &&
    JSON.stringify(
      context.shared.map(({ id, version }) => ({ id, version })),
    ) === JSON.stringify(binding.shared ?? [])
  );
}
function supportsCriteria(
  binding: WorkerBinding,
  observation: WorkerObservation,
  support: readonly CriterionSupport[],
): boolean {
  return (
    support.length === binding.criteria.length &&
    binding.criteria.every((criterion) => {
      const entries = support.filter((entry) => entry.criterion === criterion);
      return (
        entries.length === 1 &&
        observation.context.evidence.some(
          (entry) =>
            entry.id === entries[0]?.evidenceID &&
            entry.kind === "tool" &&
            entry.native !== undefined &&
            (entry.criterion === undefined || entry.criterion === criterion),
        )
      );
    })
  );
}
function unsafeStep(text: string): boolean {
  // Conservative screening, not a semantic security guarantee: native admission
  // validation is also mandatory. Never route any suggestion to a reply API.
  return /\b(approve|consent|grant\s+permission|allow\s+(?:all|access)|override\s+(?:a\s+)?hold|answer\s+(?:the\s+)?(?:form|permission)|expand\s+scope)\b/i.test(
    text,
  );
}
