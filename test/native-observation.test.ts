import { describe, expect, it } from "bun:test";
import type {
  SessionInfo,
  SessionMessageInfo,
  SessionMessageAssistantTool,
  ExperimentalSessionLogOutput,
} from "@opencode/client";
import {
  readNativeObservation,
  type ObservationClient,
} from "../src/supervision.ts";
import { fingerprint, nativeToolEvidence } from "../src/context.ts";
import type { WorkerBinding, WorkerSnapshot } from "../src/state.ts";
import { captureNativeObservation, goal } from "./host.ts";

function fixture() {
  const task: WorkerBinding = {
    ...goal,
    workerID: "worker-api",
    revision: 1,
    epoch: 1,
    status: "active",
    followups: 0,
    nonprogress: 0,
  };
  const worker: SessionInfo = {
    id: task.workerID,
    projectID: "project",
    agent: task.agent,
    location: { directory: task.location },
    outcome: "succeeded",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 3, busy: 1, idle: 3 },
  };
  const call = {
    type: "tool" as const,
    id: "result",
    name: "shell",
    time: { created: 1, ran: 1, completed: 2 },
    state: {
      status: "completed" as const,
      input: { command: "check endpoint" },
      content: [{ type: "text" as const, text: "Response verified" }],
    },
  } satisfies SessionMessageAssistantTool;
  const messages: SessionMessageInfo[] = [
    {
      id: "step",
      type: "assistant",
      agent: task.agent,
      model: { id: "model", providerID: "provider" },
      time: { created: 1, completed: 2 },
      content: [call],
    },
    { id: "idle", type: "idle", outcome: "succeeded", time: { created: 3 } },
  ];
  const logs: ExperimentalSessionLogOutput[] = [
    {
      id: "started",
      created: 1,
      type: "session.execution.started",
      durable: { aggregateID: task.workerID, seq: 1, version: 1 },
      data: { sessionID: task.workerID },
    },
    {
      id: "step-started",
      created: 1,
      type: "session.step.started",
      durable: { aggregateID: task.workerID, seq: 2, version: 1 },
      data: {
        sessionID: task.workerID,
        assistantMessageID: "step",
        agent: task.agent,
        model: { id: "model", providerID: "provider" },
        started: 1,
      },
    },
    {
      id: "succeeded",
      created: 3,
      type: "session.execution.succeeded",
      durable: { aggregateID: task.workerID, seq: 3, version: 1 },
      data: { sessionID: task.workerID },
    },
  ];
  const client: ObservationClient = {
    permission: {
      request: { list: async () => ({ location: worker.location, data: [] }) },
    },
    session: {
      get: async () => worker,
      active: async () => ({}),
      context: async () => messages,
      inbox: { list: async () => [] },
      form: {
        list: async () => [],
        get: async () => {
          throw new Error("Unexpected form read");
        },
      },
    },
    message: { list: async () => ({ data: messages, cursor: {} }) },
    shell: { list: async () => ({ location: worker.location, data: [] }) },
    experimental: {
      session: {
        log: async function* () {
          yield* logs;
          yield {
            type: "log.synced",
            aggregateID: task.workerID,
            seq: logs.length,
          };
        },
      },
    },
  };
  const observed: WorkerSnapshot = {
    dataDir: "/tmp/opencode",
    location: task.location,
    sessionID: task.workerID,
    incarnation: "native-observer",
    sequence: 1,
    invalidationVersion: 0,
    messageIDs: messages.map((message) => message.id),
    contextFingerprint: fingerprint(messages),
    nativeBoundary: "idle",
    background: [],
    publishedAt: Date.now(),
  };
  return {
    task,
    worker,
    call,
    messages,
    logs,
    client,
    observed,
    read: (snapshot: WorkerSnapshot | undefined = observed) =>
      readNativeObservation(
        client,
        task,
        [],
        new AbortController().signal,
        snapshot,
      ),
  };
}

// spec: openspec/specs/worker-supervision/spec.md
describe("Settled-work supervision", () => {
  it("Evaluates a settled cross-project worker", async () => {
    if (process.env.BACKSEAT_NATIVE_HOST_TESTS === "1") {
      const { observation } = await captureNativeObservation();
      expect(observation.runtime).toEqual({ app: "2.2.5", bun: "1.4.4" });
      expect(observation.modelCalls).toBeGreaterThan(0);
      expect(observation.snapshot.background).toEqual([]);
      expect(observation.snapshot.incarnation).toBe(
        observation.registry.incarnation,
      );
      expect(observation.registry.usable).toBe(true);
      expect(observation.snapshot.invalidationVersion).toBe(
        observation.invalidation,
      );
    }
    for (const replay of [true, false]) {
      const f = fixture();
      if (!replay) f.logs.length = 0;
      const result = await f.read();
      expect(result.state).toBe("settled");
      expect(
        result.context.evidence.find((entry) => entry.kind === "tool")?.native,
      ).toEqual(nativeToolEvidence("step", f.call)?.native);
      const beforeIdle = {
        ...f.observed,
        messageIDs: ["step"],
        nativeBoundary: "step",
        contextFingerprint: fingerprint(f.messages.slice(0, 1)),
      };
      expect((await f.read(beforeIdle)).state).toBe("settled");
      for (const changed of [
        { ...f.observed, nativeBoundary: "unrelated" },
        { ...f.observed, contextFingerprint: fingerprint([]) },
        { ...f.observed, publishedAt: 1 },
      ])
        expect((await f.read(changed)).state).not.toBe("settled");
      for (const ancestry of ["descendant", "loop", "archived"] as const) {
        const n = fixture();
        n.client.session.active = async () => ({ child: { type: "running" } });
        n.client.session.get = async ({ sessionID }) =>
          sessionID === n.worker.id
            ? n.worker
            : {
                ...n.worker,
                id: "child",
                parentID: ancestry === "loop" ? "child" : n.worker.id,
                time: {
                  ...n.worker.time,
                  ...(ancestry === "archived" ? { archived: 4 } : {}),
                },
              };
        if (ancestry === "descendant")
          expect((await n.read()).state).toBe("running");
        else await expect(n.read()).rejects.toThrow("ancestry");
      }
      for (const mode of [
        "duplicate",
        "incomplete",
        "changed-result",
        "new-input",
        "old-execution",
        "get-race",
      ]) {
        const n = fixture();
        if (!replay) n.logs.length = 0;
        if (mode === "duplicate")
          n.messages.splice(1, 0, structuredClone(n.messages[0]!));
        if (mode === "incomplete" && n.messages[0]?.type === "assistant")
          delete n.messages[0].time.completed;
        if (mode === "changed-result")
          n.call.state.content = [{ type: "text", text: "Changed result" }];
        if (mode === "new-input")
          n.messages.push({
            id: "input",
            type: "synthetic",
            text: "New work",
            time: { created: 4 },
          });
        if (mode === "old-execution")
          n.messages.splice(1, 0, {
            id: "previous-idle",
            type: "idle",
            outcome: "succeeded",
            time: { created: 2 },
          });
        if (mode === "get-race") {
          let reads = 0;
          n.client.session.get = async () => ({
            ...n.worker,
            time: { ...n.worker.time, busy: ++reads === 1 ? 1 : 4 },
          });
        }
        const state = await n.read().then(
          (result) => result.state,
          () => "unavailable",
        );
        expect(state, `${replay}:${mode}`).not.toBe("settled");
      }
    }
  });
});
