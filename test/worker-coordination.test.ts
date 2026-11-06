import { describe, expect, it, spyOn } from "bun:test";
import { BackseatRpc } from "../src/rpc.ts";
import { buildContext } from "../src/context.ts";
import { COORDINATOR_TOOL_IDS } from "../src/tools.ts";
import {
  prepareNativeOperation,
  prepareNativeSend,
  type SessionOperation,
} from "../src/native-operations.ts";
import { openSharedStorage, resolveDataDirectory } from "../src/storage.ts";
import { coordinatorAgent } from "../src/coordinator-agent.ts";
import * as subprocess from "node:child_process";
import * as ownershipModule from "../src/ownership.ts";
import * as nativeConnectionModule from "../src/native-connection.ts";
import * as sharedStorageModule from "../src/storage.ts";
import * as filesystem from "node:fs/promises";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rename,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  adoptWorker,
  createWorker,
  resumeWorker,
  takeoverWorker,
  type AdoptionHost,
  type WorkerBinding,
  parseCoordinatorState,
  fingerprint,
  STATE_BOUNDS,
} from "../src/state.ts";
import {
  creationHost,
  goal,
  coordinatorDefinition,
  inheritedPolicy,
} from "./host.ts";
import {
  CoordinatorOwnership,
  acquireCoordinatorCore,
  createFilesystemOwnershipPort,
  type LockInspection,
  type OwnershipPort,
} from "../src/ownership.ts";
import {
  promisePlugin,
  createNativeBackend,
  createWorkerObserver,
  processWorkerEvent,
  type NativeBackendHost,
} from "../src/server.ts";
import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type {
  Info as NativeTool,
  ToolEditor,
} from "@opencode/plugin/promise/tool";

const nativePlugin = promisePlugin(() => {});
const nativeIdentity = () => ({
  sessionID: "coordinator",
  agent: coordinatorAgent.id,
  messageID: "message",
  id: "fixture",
});

// spec: openspec/specs/worker-supervision/spec.md
describe("Settled-work supervision", () => {
  it("Evaluates a settled cross-project worker", async () => {
    const f = await backendFixture(
      [
        {
          ...goal,
          workerID: "worker-api",
          revision: 1,
          epoch: 1,
          status: "held",
          followups: 0,
          nonprogress: 0,
        },
        {
          ...goal,
          id: "historical-task",
          workerID: "historical-worker",
          revision: 1,
          epoch: 1,
          status: "manual",
          followups: 0,
          nonprogress: 0,
        },
      ],
      0,
      false,
      false,
    );
    const identity = {
      sessionID: "coordinator",
      agent: coordinatorAgent.id,
      messageID: "supervision",
      id: "start",
    };
    f.host.observeNative = async (task, snapshots, observed) => {
      const built = buildContext(
        task,
        {
          taskID: task.id,
          workerID: task.workerID,
          turn: 1,
          entries: [
            {
              id: "assistant-1:text:0",
              kind: "worker",
              text: "Task verification complete",
            },
          ],
        },
        snapshots,
        40000,
      );
      if (built.status !== "ready") throw new Error(built.reason);
      return {
        turn: 1,
        state: "settled",
        asks: [],
        context: built.context,
        snapshot: observed,
      };
    };
    f.host.generate = async (context, validation) => {
      f.effects.push(validation ? "validate" : "suggest");
      return validation
        ? { status: "accept", rationale: "In-scope non-consent follow-up" }
        : {
            taskID: context.task.id,
            workerID: context.task.workerID,
            action: "continue",
            nextStep: "Inspect the requested source",
            scope: context.task.scope,
            progress: true,
          };
    };
    try {
      const started = await f.backend.startSupervision(identity);
      const task = (await f.backend.inspect()).bindings[0]!;
      f.observation(task);
      await f.backend.resumeTask(task.id, identity);
      expect(f.effects.filter((effect) => effect === "prompt")).toHaveLength(1);
      await expect(
        f.backend.suggest({
          taskID: task.id,
          revision: task.revision,
          epoch: (await f.backend.inspect()).bindings[0]!.epoch,
          generation: started.generation,
          evidence: {
            taskID: task.id,
            workerID: task.workerID,
            turn: 1,
            entries: [
              {
                id: "assistant-1:text:0",
                kind: "worker",
                text: "Task verification complete",
              },
            ],
          },
        }),
      ).rejects.toThrow();
      let published = false;
      await processWorkerEvent(
        {
          event: async () => {
            published = true;
          },
        },
        {
          wakeSupervision: async () => {
            expect(published).toBe(true);
          },
        },
        {
          id: "event-idle",
          created: Date.now(),
          type: "session.idle",
          data: { sessionID: task.workerID },
        },
      );
      expect(f.effects.filter((effect) => effect === "prompt")).toHaveLength(1);
      expect(f.effects.filter((effect) => effect === "suggest")).toHaveLength(
        1,
      );
      expect(f.effects.filter((effect) => effect === "validate")).toHaveLength(
        1,
      );
      const state = await f.backend.inspect();
      expect(state.bindings[0]?.followups).toBe(1);
      expect(state.intents[0]?.intent.status).toBe("admitted");
      expect(state.intents[0]?.generation).toBe(started.generation);
      await f.backend.fenceProject(task.location);
      const fenced = (await f.backend.inspect()).bindings[0]!;
      expect(fenced.status).toBe("held");
      expect(fenced.epoch).toBeGreaterThan(state.bindings[0]!.epoch);
      expect(fenced.followups).toBe(1);
      await f.backend.wakeSupervision(task.workerID);
      expect(f.effects.filter((effect) => effect === "prompt")).toHaveLength(1);
      f.observation(fenced);
      await f.backend.resumeTask(task.id, identity);
      const get = f.host.session.get;
      f.host.session.get = async (input) => {
        const session = await get(input);
        return input.sessionID === "coordinator"
          ? { ...session, agent: goal.agent }
          : session;
      };
      await f.backend.wakeSupervision("coordinator").catch(() => undefined);
      expect((await f.backend.inspect()).bindings[0]?.status).toBe("held");
      f.host.session.get = get;
      await f.backend.wakeSupervision(task.workerID);
      expect(f.effects.filter((effect) => effect === "prompt")).toHaveLength(2);
      expect((await f.backend.inspect()).bindings[0]?.followups).toBe(2);
      await f.backend.nativeControl("hold", task.id, {}, identity);
      await f.backend.wakeSupervision(task.workerID);
      expect(f.effects.filter((effect) => effect === "prompt")).toHaveLength(2);
    } finally {
      await f.backend.dispose();
    }
    const parallel = await backendFixture(
      ["first", "second"].map((id) => ({
        ...goal,
        id,
        workerID: `worker-${id}`,
        revision: 1,
        epoch: 1,
        status: "held" as const,
        followups: 0,
        nonprogress: 0,
      })),
      0,
      false,
      false,
    );
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const evaluating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const nativeAdmissions: string[] = [];
    parallel.host.observeNative = f.host.observeNative;
    parallel.host.generate = async (context, validation) => {
      if (validation)
        return { status: "accept", rationale: "In-scope follow-up" };
      if (context.task.id === "first") {
        entered();
        await gate;
      }
      return {
        taskID: context.task.id,
        workerID: context.task.workerID,
        action: "continue",
        nextStep: "Inspect the requested source",
        scope: context.task.scope,
        progress: true,
      };
    };
    parallel.host.nativeSend = async (input, sendID) => {
      const reserved = parseCoordinatorState(parallel.root()).intents.find(
        (entry) => entry.intent.id === sendID,
      );
      expect(reserved?.intent.status).toBe("reserved");
      expect(reserved?.intent.workerID).toBe(input.sessionID);
      nativeAdmissions.push(sendID);
      return { id: sendID, sessionID: input.sessionID };
    };
    try {
      await parallel.backend.startSupervision(identity);
      for (const binding of (await parallel.backend.inspect()).bindings)
        parallel.observation(binding);
      const first = parallel.backend.resumeTask("first", identity);
      await evaluating;
      const second = parallel.backend.resumeTask("second", identity);
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      expect((await first).accepted).toBe(true);
      expect((await second).accepted).toBe(true);
      expect(nativeAdmissions).toHaveLength(2);
      const persisted = await parallel.backend.inspect();
      expect(persisted.bindings.map((binding) => binding.followups)).toEqual([
        1, 1,
      ]);
      expect(persisted.intents.map((entry) => entry.intent.id).sort()).toEqual(
        nativeAdmissions.sort(),
      );
      expect(
        persisted.intents.every((entry) => entry.intent.status === "admitted"),
      ).toBe(true);
    } finally {
      release();
      await parallel.backend.dispose();
    }
  });
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Explicit native request replies", () => {
  const identity = {
    sessionID: "coordinator",
    agent: coordinatorAgent.id,
    messageID: "manual-request",
    id: "reply",
  };
  const cases = [
    {
      operation: "reply_permission" as const,
      payload: {
        requestID: "permission-1",
        decision: "once",
        message: "Approved once",
      },
    },
    {
      operation: "reply_form" as const,
      payload: {
        formID: "form-1",
        answer: { choice: ["selected"], proceed: true, count: 2 },
      },
    },
    {
      operation: "request_permission" as const,
      payload: { action: "shell", resources: ["make test"] },
    },
    {
      operation: "remove_saved_permission" as const,
      payload: { id: "saved-1" },
    },
  ];
  it("Replies to the selected native request", async () => {
    for (const entry of cases) {
      const { backend, host, asks } = await backendFixture([], 0, false, false);
      const calls: unknown[] = [];
      host.nativeOperation = async (input, phase) => {
        if (phase === "subject")
          return {
            id: "selected-request",
            state: "pending",
            resources: ["make test"],
          };
        calls.push(input);
        return { accepted: true };
      };
      const input = {
        ...entry,
        sessionID: "native-worker",
        location: goal.location,
        agent: goal.agent,
      };
      expect(await backend.sessionOperation(input, identity)).toEqual({
        status: "completed",
        result: { accepted: true },
      });
      expect(calls).toEqual([input]);
      expect(asks).toEqual([`backseat.${entry.operation}`]);
      expect((await backend.inspect(identity)).bindings).toEqual([]);
      await backend.dispose();
    }
    const nativeCalls: unknown[] = [];
    const request = {
      id: "permission-1",
      sessionID: "native-worker",
      action: "shell",
      resources: ["make test"],
    };
    const form = {
      id: "form-1",
      sessionID: "native-worker",
      title: "Select",
      fields: [{ id: "choice", type: "string", title: "Choice" }],
      state: { status: "pending" },
    };
    const native = {
      session: {
        form: {
          get: async () => form,
          reply: async (input: unknown) => {
            nativeCalls.push(input);
          },
        },
      },
      permission: {
        get: async () => request,
        reply: async (input: unknown) => {
          nativeCalls.push(input);
        },
      },
    } as unknown as OpenCodeClient;
    for (const entry of cases.slice(0, 2)) {
      const input = {
        ...entry,
        sessionID: "native-worker",
        location: goal.location,
        agent: goal.agent,
      };
      const prepared = prepareNativeOperation(input);
      expect(
        await prepared.subject(native, new AbortController().signal),
      ).toEqual(entry.operation === "reply_permission" ? request : form);
      await prepared.execute(native, new AbortController().signal);
      expect(nativeCalls.at(-1)).toEqual({
        sessionID: input.sessionID,
        ...entry.payload,
      });
    }
    const saved = {
      id: "saved-1",
      projectID: "selected-project",
      action: "shell",
      resource: "make test",
      time: { created: 1, updated: 1 },
    };
    let rows = [saved, { ...saved, projectID: "another-project" }];
    let selected = {
      id: "native-worker",
      projectID: saved.projectID,
      agent: goal.agent,
      location: { directory: goal.location },
      revert: { messageID: "staged-message" },
    };
    const scopedCalls: unknown[] = [];
    const scopedClient = {
      session: {
        get: async () => selected,
        revert: {
          commit: async (input: unknown) => {
            scopedCalls.push(["commit", input]);
          },
        },
      },
      permission: {
        create: async (input: unknown) => {
          scopedCalls.push(["create", input]);
        },
        saved: {
          list: async (input: unknown) => {
            scopedCalls.push(["list", input]);
            return rows;
          },
          remove: async (input: unknown) => {
            scopedCalls.push(["remove", input]);
          },
        },
      },
    } as unknown as OpenCodeClient;
    const target = {
      sessionID: "native-worker",
      location: goal.location,
      agent: goal.agent,
    };
    const signal = new AbortController().signal;
    const removal = prepareNativeOperation({
      ...target,
      operation: "remove_saved_permission",
      payload: { id: saved.id },
    });
    expect(await removal.subject(scopedClient, signal)).toEqual(saved);
    expect(scopedCalls.at(-1)).toEqual([
      "list",
      { projectID: saved.projectID },
    ]);
    await removal.execute(scopedClient, signal);
    expect(scopedCalls.at(-1)).toEqual(["remove", { id: saved.id }]);
    for (const invalid of [
      [{ ...saved, projectID: "another-project" }],
      [saved, saved],
    ]) {
      rows = invalid;
      await expect(removal.subject(scopedClient, signal)).rejects.toThrow(
        "unavailable",
      );
    }
    const permissionPayload = {
      action: "shell",
      resources: ["make test"],
      save: ["make test"],
    };
    await prepareNativeOperation({
      ...target,
      operation: "request_permission",
      payload: permissionPayload,
    }).execute(scopedClient, signal);
    expect(scopedCalls.at(-1)).toEqual([
      "create",
      { sessionID: target.sessionID, ...permissionPayload },
    ]);
    const commit = prepareNativeOperation({
      ...target,
      operation: "commit_session_revert",
      payload: {},
    });
    expect(await commit.subject(scopedClient, signal)).toEqual(selected.revert);
    await commit.execute(scopedClient, signal);
    expect(scopedCalls.at(-1)).toEqual([
      "commit",
      { sessionID: target.sessionID },
    ]);
    for (const changed of [
      { ...selected, id: "another-worker" },
      { ...selected, location: { directory: "/different/project" } },
    ]) {
      selected = changed;
      await expect(commit.subject(scopedClient, signal)).rejects.toThrow(
        "changed",
      );
    }
    const bound = {
      ...goal,
      workerID: "native-worker",
      revision: 1,
      epoch: 2,
      status: "active" as const,
      followups: 2,
      nonprogress: 1,
    };
    const fixture = await backendFixture([bound], 0, false, false);
    fixture.host.nativeOperation = async () => null;
    const epoch = (await fixture.backend.inspect(identity)).bindings[0]!.epoch;
    await fixture.backend.sessionOperation(
      {
        ...cases[0]!,
        sessionID: bound.workerID,
        location: goal.location,
        agent: goal.agent,
      },
      identity,
    );
    expect((await fixture.backend.inspect(identity)).bindings[0]).toMatchObject(
      { status: "manual", epoch: epoch + 1, followups: 2, nonprogress: 1 },
    );
    await fixture.backend.dispose();
  });
  it("Rejects a changed or unapproved reply", async () => {
    for (const failure of [
      "denied",
      "request-changed",
      "target-changed",
      "invalid-answer",
    ] as const) {
      const { backend, host, approve, move } = await backendFixture(
        [],
        0,
        false,
        false,
      );
      let subject = "original",
        executions = 0;
      host.nativeOperation = async (_input, phase) => {
        if (phase === "subject")
          return { id: "request-1", state: "pending", text: subject };
        executions++;
      };
      approve(async () => {
        if (failure === "denied") throw new Error("Native approval denied");
        if (failure === "request-changed") subject = "changed";
        if (failure === "target-changed") move();
      });
      const input = {
        operation: "reply_form" as const,
        sessionID: "native-worker",
        location: goal.location,
        agent: goal.agent,
        payload: {
          formID: "form-1",
          answer:
            failure === "invalid-answer"
              ? { invalid: { nested: true } }
              : { proceed: true },
        },
      };
      await expect(backend.sessionOperation(input, identity)).rejects.toThrow();
      expect(executions).toBe(0);
      await backend.dispose();
    }
  });
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Full native session controls", () => {
  const identity = {
    sessionID: "coordinator",
    agent: coordinatorAgent.id,
    messageID: "native-control",
    id: "control",
  };
  const operations = [
    [
      "fork_session",
      { before: "message-before" },
      "fork",
      { before: "message-before" },
    ],
    [
      "switch_session_agent",
      { newAgent: "reviewer" },
      "switchAgent",
      { agent: "reviewer" },
    ],
    [
      "switch_session_model",
      { model: { id: "model", providerID: "provider", variant: "medium" } },
      "switchModel",
      { model: { id: "model", providerID: "provider", variant: "medium" } },
    ],
    [
      "update_session",
      {
        title: "Selected title",
        metadata: { selected: true },
        permissions: [
          { action: "shell", resource: "make test", effect: "ask" },
        ],
        archived: false,
      },
      "update",
      {
        title: "Selected title",
        metadata: { selected: true },
        permissions: [
          { action: "shell", resource: "make test", effect: "ask" },
        ],
        archived: false,
      },
    ],
    [
      "move_session",
      { workdir: "/projects/destination", delivery: "queue" },
      "move",
      { directory: "/projects/destination", delivery: "queue" },
    ],
    ["interrupt_session", { resume: false }, "interrupt", { resume: false }],
    ["background_session", {}, "background", {}],
    ["wait_session", {}, "wait", {}],
    [
      "generate_session",
      { prompt: "Summarize selected context" },
      "generate",
      { prompt: "Summarize selected context" },
    ],
    [
      "stage_session_revert",
      { messageID: "boundary", files: true },
      "stage",
      { messageID: "boundary", files: true },
    ],
    ["clear_session_revert", {}, "clear", {}],
    ["commit_session_revert", {}, "commit", {}],
    [
      "set_session_environment",
      { variables: { SELECTED: "", MODE: "test" } },
      "environment",
      { variables: { SELECTED: "", MODE: "test" } },
    ],
    [
      "put_session_instruction",
      { key: "selected", value: { enabled: true } },
      "put",
      { key: "selected", value: { enabled: true } },
    ],
    [
      "remove_session_instruction",
      { key: "selected" },
      "remove",
      { key: "selected" },
    ],
    ["mark_session_viewed", { idle: 42 }, "view", { idle: 42 }],
  ] as const;
  it("Executes approved native session operations", async () => {
    const f = await backendFixture([], 0, false, false);
    const agents = f.host.agent.list;
    f.host.agent.list = async (...args) => {
      const catalog = await agents(...args);
      return {
        ...catalog,
        data: [
          ...catalog.data,
          {
            ...catalog.data.find((agent) => agent.id === goal.agent)!,
            id: "reviewer",
          },
        ],
      };
    };
    const calls: unknown[] = [];
    f.host.nativeOperation = async (input, phase) => {
      if (phase === "subject") return null;
      calls.push(input);
      return { native: true };
    };
    for (const [operation, payload] of operations) {
      const input = {
        operation,
        sessionID: "native-worker",
        location: goal.location,
        agent: goal.agent,
        payload,
      };
      expect(await f.backend.sessionOperation(input, identity)).toEqual({
        status: "completed",
        result: { native: true },
      });
      expect(calls.at(-1)).toEqual(input);
      expect(f.asks.at(-1)).toBe(`backseat.${operation}`);
    }
    expect((await f.backend.inspect(identity)).bindings).toEqual([]);
    const get = f.host.session.get;
    f.host.session.get = async (input) => {
      const session = await get(input);
      return input.sessionID === "native-worker"
        ? { ...session, time: { ...session.time, archived: 10 } }
        : session;
    };
    expect(
      await f.backend.sessionOperation(
        {
          operation: "update_session",
          sessionID: "native-worker",
          location: goal.location,
          agent: goal.agent,
          payload: { archived: false },
        },
        identity,
      ),
    ).toEqual({ status: "completed", result: { native: true } });
    await f.backend.dispose();
    const callsAtNative: unknown[] = [];
    const nativeCall = (name: string) => async (payload: unknown) => {
      callsAtNative.push([name, payload]);
    };
    const native = {
      session: {
        ...Object.fromEntries(
          [
            "fork",
            "switchAgent",
            "switchModel",
            "update",
            "move",
            "interrupt",
            "background",
            "generate",
            "environment",
            "view",
          ].map((name) => [name, nativeCall(name)]),
        ),
        revert: Object.fromEntries(
          ["stage", "clear", "commit"].map((name) => [name, nativeCall(name)]),
        ),
      },
      experimental: {
        session: {
          wait: nativeCall("wait"),
          instructions: {
            entry: { put: nativeCall("put"), remove: nativeCall("remove") },
          },
        },
      },
    } as unknown as OpenCodeClient;
    for (const [operation, payload, method, expected] of operations) {
      await prepareNativeOperation({
        operation,
        payload,
        sessionID: "native-worker",
        location: goal.location,
        agent: goal.agent,
      }).execute(native, new AbortController().signal);
      expect(callsAtNative.at(-1)).toEqual([
        method,
        { sessionID: "native-worker", ...expected },
      ]);
    }
    for (const operation of [
      "cancel_session_input",
      "update_session_input",
      "cancel_session_form",
    ] as const) {
      const payload =
        operation === "cancel_session_form"
          ? { formID: "selected-form" }
          : {
              inboxID: "selected-input",
              ...(operation === "update_session_input"
                ? { delivery: "queue" }
                : {}),
            };
      const prepared = prepareNativeOperation({
        operation,
        payload,
        sessionID: "native-worker",
        location: goal.location,
        agent: goal.agent,
      } as SessionOperation);
      const selectedInput = {
        id: "selected-input",
        sessionID: "native-worker",
        delivery: "steer",
      };
      const selectedForm = {
        id: "selected-form",
        sessionID: "native-worker",
        state: { status: "pending" },
      };
      const selectedClient = {
        session: {
          inbox: {
            list: async () => [selectedInput],
            cancel: nativeCall("cancel-input"),
            update: nativeCall("update-input"),
          },
          form: {
            get: async () => selectedForm,
            cancel: nativeCall("cancel-form"),
          },
        },
      } as unknown as OpenCodeClient;
      expect(
        await prepared.subject(selectedClient, new AbortController().signal),
      ).toEqual(
        operation === "cancel_session_form" ? selectedForm : selectedInput,
      );
      await prepared.execute(selectedClient, new AbortController().signal);
      expect(callsAtNative.at(-1)).toEqual([
        operation === "cancel_session_form"
          ? "cancel-form"
          : operation === "cancel_session_input"
            ? "cancel-input"
            : "update-input",
        { sessionID: "native-worker", ...payload },
      ]);
      if (operation === "cancel_session_form")
        selectedForm.state.status = "replied";
      else selectedInput.sessionID = "other-session";
      await expect(
        prepared.subject(selectedClient, new AbortController().signal),
      ).rejects.toThrow();
    }
    const formFields = [
      {
        key: "decision",
        type: "string",
        required: true,
        options: [{ value: "yes", label: "Yes" }],
      },
    ];
    const createForm = prepareNativeOperation({
      operation: "create_session_form",
      sessionID: "native-worker",
      location: goal.location,
      agent: goal.agent,
      payload: {
        formID: "form_selected",
        title: "Select an answer",
        fields: formFields,
      },
    } as SessionOperation);
    await createForm.execute(
      {
        session: { form: { create: nativeCall("create-form") } },
      } as unknown as OpenCodeClient,
      new AbortController().signal,
    );
    expect(callsAtNative.at(-1)).toEqual([
      "create-form",
      {
        sessionID: "native-worker",
        id: "form_selected",
        title: "Select an answer",
        fields: formFields,
      },
    ]);
    expect(() =>
      prepareNativeOperation({
        operation: "create_session_form",
        sessionID: "native-worker",
        location: goal.location,
        agent: goal.agent,
        payload: {
          formID: "form_selected",
          title: "Select an answer",
          fields: [{ key: "bad", type: "unknown" }],
        },
      } as SessionOperation),
    ).toThrow();
    const creation = await backendFixture([], 0, false, false);
    let creates = 0;
    creation.host.nativeOperation = async (input, phase) => {
      if (phase === "subject") return null;
      creates++;
      const reserved = parseCoordinatorState(
        creation.root(),
      ).sessionDeliveries?.at(-1);
      expect(reserved?.sessionID).toBe(input.sessionID);
      expect(reserved?.status).toBe("reserved");
      return {
        id: input.sessionID,
        agent: input.agent,
        location: { directory: input.location },
      };
    };
    const createInput = {
      operation: "create_native_session",
      sessionID: "ses_selected",
      location: goal.location,
      agent: goal.agent,
      payload: { title: "Selected session" },
    } as SessionOperation;
    expect(
      await creation.backend.sessionOperation(createInput, identity),
    ).toMatchObject({ status: "completed", sessionID: "ses_selected" });
    expect(
      await creation.backend.sessionOperation(createInput, identity),
    ).toMatchObject({ status: "completed", sessionID: "ses_selected" });
    expect(creates).toBe(1);
    expect((await creation.backend.inspect(identity)).bindings).toEqual([]);
    await creation.backend.dispose();
    for (const operation of [
      "create_native_session",
      "import_session",
    ] as const) {
      for (const resolution of ["approved", "denied", "changed"] as const) {
        const uncertain = await backendFixture([], 0, false, false);
        let nativeCreates = 0;
        uncertain.host.nativeOperation = async (_input, phase) => {
          if (phase === "subject") return null;
          nativeCreates++;
          throw new Error("Acknowledgement lost");
        };
        const input = {
          ...createInput,
          operation,
          payload:
            operation === "import_session"
              ? {
                  transfer: {
                    info: {
                      id: "ses_selected",
                      projectID: "project",
                      agent: goal.agent,
                      location: { directory: goal.location },
                      cost: 0,
                      tokens: {
                        input: 0,
                        output: 0,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                      },
                      time: { created: 1, updated: 1 },
                    },
                    messages: [],
                  },
                }
              : createInput.payload,
        };
        try {
          expect(
            await uncertain.backend.sessionOperation(input, identity),
          ).toMatchObject({ status: "uncertain", sessionID: "ses_selected" });
          expect(
            await uncertain.backend.sessionOperation(input, identity),
          ).toMatchObject({ status: "uncertain", sessionID: "ses_selected" });
          expect(nativeCreates).toBe(1);
          const altered = structuredClone(input);
          if ("transfer" in altered.payload && altered.payload.transfer)
            (
              altered.payload
                .transfer as import("@opencode/client").SessionTransferData
            ).info.cost = 1;
          else altered.payload = { title: "Different requested session" };
          await expect(
            uncertain.backend.sessionOperation(altered, identity),
          ).rejects.toThrow("reserved");
          await expect(
            uncertain.backend.sessionOperation(input, {
              ...identity,
              sessionID: "another-coordinator",
            }),
          ).rejects.toThrow();
          expect(nativeCreates).toBe(1);
          const request = {
            sessionID: "ses_selected",
            location: goal.location,
            agent: goal.agent,
            text: "Use the inspected native session",
          };
          if (resolution !== "approved") {
            uncertain.approve(async () => {
              if (resolution === "denied") throw new Error("Resolution denied");
              uncertain.move();
            });
            await expect(
              uncertain.backend.sendSession(request, {
                ...identity,
                id: "after-creation",
              }),
            ).rejects.toThrow();
            expect(
              parseCoordinatorState(uncertain.root()).sessionDeliveries![0]!
                .status,
            ).toBe("ambiguous");
            expect(nativeCreates).toBe(1);
            continue;
          }
          expect(
            (
              await uncertain.backend.sendSession(request, {
                ...identity,
                id: "after-creation",
              })
            ).status,
          ).toBe("admitted");
          expect(uncertain.asks).toContain(
            "backseat.reconcile_session_creation",
          );
          expect(
            parseCoordinatorState(uncertain.root()).sessionDeliveries![0]!
              .status,
          ).toBe("admitted");
          expect(nativeCreates).toBe(1);
        } finally {
          await uncertain.backend.dispose();
        }
      }
    }
    await prepareNativeOperation(createInput).execute(
      {
        session: { create: nativeCall("create-session") },
      } as unknown as OpenCodeClient,
      new AbortController().signal,
    );
    expect(callsAtNative.at(-1)).toEqual([
      "create-session",
      {
        id: "ses_selected",
        agent: goal.agent,
        location: { directory: goal.location },
        title: "Selected session",
      },
    ]);
    const transfer = {
      info: {
        id: "ses_imported",
        projectID: "project",
        agent: goal.agent,
        location: { directory: "/projects/source" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: { created: 1, updated: 1 },
      },
      messages: [],
    };
    const importInput = {
      operation: "import_session",
      sessionID: "ses_imported",
      location: goal.location,
      agent: goal.agent,
      payload: { transfer },
    } as SessionOperation;
    await prepareNativeOperation(importInput).execute(
      {
        experimental: { session: { import: nativeCall("import-session") } },
      } as unknown as OpenCodeClient,
      new AbortController().signal,
    );
    expect(callsAtNative.at(-1)).toEqual([
      "import-session",
      { ...transfer, location: { directory: goal.location } },
    ]);
    expect(() =>
      prepareNativeOperation({
        ...importInput,
        sessionID: "different-session",
      }),
    ).toThrow("identity");
  });
  it("Rejects denied stale or unsupported controls", async () => {
    for (const failure of [
      "denied",
      "stale",
      "unsupported",
      "cancelled",
      "invalid-payload",
      "coordinator-agent",
    ] as const) {
      const f = await backendFixture([], 0, false, false);
      let executes = 0;
      f.host.nativeOperation = async (_input, phase) => {
        if (phase === "execute") executes++;
        return null;
      };
      const abort = new AbortController();
      f.approve(async () => {
        if (failure === "denied") throw new Error("Native approval denied");
        if (failure === "stale") f.move();
        if (failure === "cancelled") abort.abort();
      });
      const input = {
        operation:
          failure === "unsupported"
            ? "unknown_native_control"
            : failure === "coordinator-agent"
              ? "switch_session_agent"
              : "interrupt_session",
        sessionID: "native-worker",
        location: goal.location,
        agent: goal.agent,
        payload:
          failure === "invalid-payload"
            ? { resume: "not-boolean" }
            : failure === "coordinator-agent"
              ? { newAgent: coordinatorAgent.id }
              : { resume: false },
      };
      await expect(
        f.backend.sessionOperation(
          input as Parameters<typeof f.backend.sessionOperation>[0],
          { ...identity, signal: abort.signal },
        ),
      ).rejects.toThrow();
      expect(executes).toBe(0);
      await f.backend.dispose();
    }
    const f = await backendFixture([], 0, false, false);
    f.host.nativeOperation = async (_input, phase) => {
      if (phase === "execute")
        throw new Error("Private native payload must not escape");
      return null;
    };
    const result = await f.backend.sessionOperation(
      {
        operation: "interrupt_session",
        sessionID: "native-worker",
        location: goal.location,
        agent: goal.agent,
        payload: {},
      },
      identity,
    );
    expect(result).toMatchObject({ status: "uncertain" });
    expect(JSON.stringify(result)).not.toContain("Private native payload");
    await f.backend.dispose();
  });
});

type NativeAgent = NonNullable<ReturnType<AgentEditor["get"]>>;
type NativeExecutionEvent = Pick<
  ToolContext,
  "sessionID" | "agent" | "messageID" | "id"
> & { tool: string; input: unknown };
const observerScope = {
  dataDir: "/projects/home",
  coordinatorLocation: "/projects/home",
};

// spec: openspec/specs/worker-coordination/spec.md
describe("Shared durable coordination store", () => {
  it("Reloads task-free delivery state without resetting tasks", async () => {
    const { host } = creationHost();
    const binding = {
      ...(await createWorker(goal, host)),
      followups: 2,
      nonprogress: 1,
    };
    const populated = {
      version: 1,
      bindings: [binding],
      snapshots: [],
      intents: [],
      completions: [],
    };
    const previous = parseCoordinatorState(populated);
    const delivery = {
      id: "msg_unbound",
      sessionID: "unbound-worker",
      location: "/projects/other",
      agent: "engineer",
      coordinatorID: "coordinator",
      serviceID: "native-incarnation",
      operation: "prompt",
      fingerprint: fingerprint({ text: "Approved assignment" }),
      createdAt: 1,
      status: "ambiguous",
    };
    const encoded = JSON.stringify({
      ...populated,
      version: 2,
      sessionDeliveries: [delivery],
    });
    const loaded = parseCoordinatorState(JSON.parse(encoded));
    expect(loaded.bindings).toEqual(previous.bindings);
    expect(loaded.intents).toEqual(previous.intents);
    expect(loaded).toMatchObject({
      version: 2,
      sessionDeliveries: [delivery],
    });
    expect(parseCoordinatorState(JSON.parse(JSON.stringify(loaded)))).toEqual(
      loaded,
    );
    expect(JSON.stringify(populated)).toBe(JSON.stringify(previous));
    const proven = {
      ...loaded,
      deliveryCutoff: 10,
      sessionDeliveries: [
        {
          ...loaded.sessionDeliveries![0]!,
          invocation: {
            messageID: "assistant-parent",
            callID: "native-tool-call",
            createdAt: 20,
          },
        },
      ],
    };
    expect(parseCoordinatorState(JSON.parse(JSON.stringify(proven)))).toEqual(
      proven,
    );
  });

  it("Retires confirmed deliveries without replaying expired invocations", async () => {
    const records = Array.from(
      { length: STATE_BOUNDS.sessionDeliveries },
      (_, i) => ({
        id: `msg_retained_${i}`,
        sessionID: "historical-worker",
        location: goal.location,
        agent: goal.agent,
        coordinatorID: "coordinator",
        serviceID: "incarnation",
        operation: "prompt" as const,
        fingerprint: fingerprint(i),
        createdAt: i,
        status: "admitted" as const,
        invocation: {
          messageID: `parent_${i}`,
          callID: `call_${i}`,
          createdAt: i + 1,
        },
      }),
    );
    const base = {
      ...parseCoordinatorState(undefined),
      version: 2 as const,
      sessionDeliveries: records,
    };
    const request = {
      sessionID: "worker",
      location: goal.location,
      agent: goal.agent,
      text: "New assignment",
    };
    const f = await backendFixture([], 0, false, false, [], base);
    try {
      expect(
        (await f.backend.sendSession(request, nativeIdentity())).status,
      ).toBe("admitted");
      const state = parseCoordinatorState(f.root());
      expect(state.sessionDeliveries).toHaveLength(800);
      expect(state.deliveryCutoff).toBe(1);
      expect(
        state.sessionDeliveries!.some((r) => r.id === records[0]!.id),
      ).toBe(false);
      const reload = parseCoordinatorState(JSON.parse(JSON.stringify(state)));
      expect(reload.deliveryCutoff).toBe(1);
      f.host.readInvocation = async (identity) => ({
        messageID: identity.messageID,
        createdAt: 1,
      });
      for (const id of ["retired-call", "same-time-other-call"]) {
        await expect(
          f.backend.sendSession(
            { ...request, text: id },
            { ...nativeIdentity(), id },
          ),
        ).rejects.toThrow("expired");
      }
      expect(f.effects.filter((e) => e === "prompt")).toHaveLength(1);
      const restored = await backendFixture([], 0, false, false, [], reload);
      restored.host.readInvocation = async (identity) => ({
        messageID: identity.messageID,
        createdAt: 1,
      });
      try {
        await expect(
          restored.backend.sendSession(request, {
            ...nativeIdentity(),
            id: "expired-after-reload",
          }),
        ).rejects.toThrow("expired");
        expect(restored.effects).not.toContain("prompt");
      } finally {
        await restored.backend.dispose();
      }
    } finally {
      await f.backend.dispose();
    }
    for (const mode of [
      "ambiguous",
      "legacy",
      "missing-proof",
      "wrong-message",
      "negative-time",
      "unsupported-proof",
    ] as const) {
      const pinned = records.map(({ invocation, ...record }) => ({
        ...record,
        ...(mode === "legacy" ? {} : { invocation }),
        ...(mode === "ambiguous" ? { status: "ambiguous" as const } : {}),
      }));
      const held = await backendFixture([], 0, false, false, [], {
        ...base,
        sessionDeliveries: pinned,
      });
      if (mode === "missing-proof")
        held.host.readInvocation = async () => {
          throw new Error("Unavailable message");
        };
      if (mode === "wrong-message" || mode === "negative-time")
        held.host.readInvocation = async (identity) => ({
          messageID:
            mode === "wrong-message" ? "different-message" : identity.messageID,
          createdAt: mode === "negative-time" ? -1 : 1000,
        });
      if (mode === "unsupported-proof") delete held.host.readInvocation;
      try {
        await expect(
          held.backend.sendSession(request, nativeIdentity()),
        ).rejects.toThrow();
        expect(held.effects).not.toContain("prompt");
        expect(
          parseCoordinatorState(held.root()).sessionDeliveries,
        ).toHaveLength(800);
      } finally {
        await held.backend.dispose();
      }
    }
  });

  it("Rejects incompatible delivery records without reset", () => {
    const delivery = {
      id: "msg_unbound",
      sessionID: "unbound-worker",
      location: "/projects/other",
      agent: "engineer",
      coordinatorID: "coordinator",
      serviceID: "native-incarnation",
      operation: "prompt",
      fingerprint: fingerprint({ text: "Approved assignment" }),
      createdAt: 1,
      status: "ambiguous",
    };
    const base = parseCoordinatorState(undefined);
    const extended = { ...base, version: 2, sessionDeliveries: [delivery] };
    for (const invalid of [
      { ...extended, version: 1 },
      { ...base, version: 2 },
      { ...extended, version: 3 },
      { ...extended, deliveryCutoff: -1 },
      {
        ...extended,
        sessionDeliveries: [
          {
            ...delivery,
            invocation: { messageID: "parent", callID: "call", createdAt: -1 },
          },
        ],
      },
      {
        ...extended,
        sessionDeliveries: [
          {
            ...delivery,
            invocation: { messageID: "parent", callID: "", createdAt: 1 },
          },
        ],
      },
      { ...extended, sessionDeliveries: [delivery, delivery] },
      {
        ...extended,
        sessionDeliveries: Array.from(
          { length: STATE_BOUNDS.sessionDeliveries + 1 },
          (_, index) => ({
            ...delivery,
            id: `msg_${index}`,
          }),
        ),
      },
      ...[
        { status: "delivered" },
        { fingerprint: "not-a-fingerprint" },
        { createdAt: -1 },
        { id: "x".repeat(201) },
        { sessionID: "" },
        { operation: "arbitrary" },
        { text: "Do not persist prompt content" },
      ].map((change) => ({
        ...extended,
        sessionDeliveries: [{ ...delivery, ...change }],
      })),
    ]) {
      const encoded = JSON.stringify(invalid);
      expect(() => parseCoordinatorState(invalid)).toThrow();
      expect(JSON.stringify(invalid)).toBe(encoded);
    }
  });

  it("Preserves populated stores across manual assignments", async () => {
    const { host } = creationHost();
    const binding = {
      ...(await createWorker(goal, host)),
      followups: 2,
      nonprogress: 1,
    };
    const initial = {
      intent: {
        id: "msg_initial",
        taskID: binding.id,
        workerID: binding.workerID,
        identity: "initial",
        text: "Approved task",
        nonprogress: 0,
        status: "admitted" as const,
      },
      revision: binding.revision,
      epoch: binding.epoch,
      generation: 0,
      createdAt: 1,
      kind: "initial" as const,
    };
    const manual = {
      ...initial,
      kind: "manual" as const,
      intent: {
        ...initial.intent,
        id: "msg_manual",
        identity: "manual",
        status: "ambiguous" as const,
      },
    };
    const populated = {
      version: 1,
      bindings: [binding],
      snapshots: [],
      intents: [initial],
      completions: [],
    };
    const previous = parseCoordinatorState(populated);
    const loaded = parseCoordinatorState({
      ...populated,
      intents: [
        initial,
        manual,
        { ...manual, intent: { ...manual.intent, id: "msg_manual2" } },
        { ...manual, intent: { ...manual.intent, id: "msg_manual3" } },
      ],
    });
    expect(loaded.bindings).toEqual(previous.bindings);
    expect(loaded.intents[0]).toEqual(previous.intents[0]);
    expect(loaded.intents[1]).toEqual(manual);
    expect(parseCoordinatorState(JSON.parse(JSON.stringify(loaded)))).toEqual(
      loaded,
    );
  });

  it("Rejects invalid manual-delivery records", async () => {
    const { host } = creationHost();
    const binding = await createWorker(goal, host);
    const manual = {
      intent: {
        id: "msg_manual",
        taskID: binding.id,
        workerID: binding.workerID,
        identity: "manual",
        text: "Approved assignment",
        nonprogress: 0,
        status: "reserved",
      },
      revision: binding.revision,
      epoch: binding.epoch,
      generation: 0,
      createdAt: 1,
      kind: "manual",
    };
    const state = {
      version: 1,
      bindings: [binding],
      snapshots: [],
      completions: [],
    };
    for (const invalid of [
      { ...manual, generation: 1 },
      { ...manual, validation: {} },
      { ...manual, intent: { ...manual.intent, workerID: "another-worker" } },
      { ...manual, intent: { ...manual.intent, id: "x".repeat(201) } },
      { ...manual, intent: { ...manual.intent, nonprogress: 1 } },
    ])
      expect(() =>
        parseCoordinatorState({ ...state, intents: [invalid] }),
      ).toThrow();
  });

  it("Shares an XDG-backed store across projects", async () => {
    expect(
      resolveDataDirectory({}, { home: "/users/example", XDG_DATA_HOME: "" }),
    ).toBe("/users/example/.local/share/opencode-backseat");
    expect(resolveDataDirectory({}, { home: "/users/example" })).toBe(
      "/users/example/.local/share/opencode-backseat",
    );
    expect(
      resolveDataDirectory(
        {},
        { home: "/users/example", XDG_DATA_HOME: "/data" },
      ),
    ).toBe("/data/opencode-backseat");
    expect(
      resolveDataDirectory(
        {},
        { home: "/users/example", XDG_DATA_HOME: "relative" },
      ),
    ).toBe("/users/example/.local/share/opencode-backseat");
    expect(
      resolveDataDirectory(
        { dataDir: "/custom/store" },
        { home: "/users/example", XDG_DATA_HOME: "/data" },
      ),
    ).toBe("/custom/store");
    const root = resolve(".opencode/backseat");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const fixture = await mkdtemp(`${root}/shared-store-`);
    const directory = resolveDataDirectory(
      {},
      { home: fixture, XDG_DATA_HOME: fixture },
    );
    try {
      const oldDirectory = `${fixture}/opencode-conman`;
      const oldStore = await openSharedStorage(oldDirectory);
      try {
        await oldStore.set("task", { uncertain: true, followUps: 2 });
      } finally {
        await oldStore.close();
      }
      const oldState = await readFile(`${oldDirectory}/state.json`, "utf8");
      const first = await openSharedStorage(directory);
      try {
        expect(await first.get("task")).toBeUndefined();
        await first.set("task", {
          location: "/projects/one",
          followUps: 2,
          uncertain: true,
        });
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(`${directory}/state.json`)).mode & 0o777).toBe(
          0o600,
        );
      } finally {
        await first.close();
      }
      const second = await openSharedStorage(directory);
      try {
        expect(await second.get("task")).toEqual({
          location: "/projects/one",
          followUps: 2,
          uncertain: true,
        });
      } finally {
        await second.close();
      }
      expect(await readFile(`${oldDirectory}/state.json`, "utf8")).toBe(
        oldState,
      );
      expect(
        resolveDataDirectory({ dataDir: oldDirectory }, { home: fixture }),
      ).toBe(oldDirectory);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("Supports trusted writable storage ancestry", async () => {
    const root = resolve(".opencode/backseat");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const fixture = await mkdtemp(`${root}/writable-ancestry-`);
    try {
      for (const mode of [0o775, 0o2775, 0o1777]) {
        const parent = `${fixture}/${mode}`;
        await mkdir(parent);
        await chmod(parent, mode);
        const directory = `${parent}/store`;
        const first = await openSharedStorage(directory);
        try {
          await first.set("limits", { followUps: 2, uncertain: true });
        } finally {
          await first.close();
        }
        const second = await openSharedStorage(directory);
        try {
          expect(await second.get("limits")).toEqual({
            followUps: 2,
            uncertain: true,
          });
          expect((await stat(directory)).mode & 0o777).toBe(0o700);
          expect((await stat(`${directory}/state.json`)).mode & 0o777).toBe(
            0o600,
          );
        } finally {
          await second.close();
        }
        const owner = new CoordinatorOwnership(
          directory,
          "owner",
          createFilesystemOwnershipPort(async () => {}),
        );
        const contender = new CoordinatorOwnership(
          directory,
          "contender",
          createFilesystemOwnershipPort(async () => {}),
        );
        try {
          expect(await owner.claim()).toBe("owned");
          expect(await contender.claim()).not.toBe("owned");
        } finally {
          await contender.dispose(async () => {});
          await owner.dispose(async () => {});
        }
        expect((await stat(parent)).mode & 0o7777).toBe(mode);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("Holds unsafe or corrupt shared storage", async () => {
    for (const dataDir of ["", "relative/store"]) {
      const project = await registeredCoordinator(false, undefined, dataDir);
      try {
        expect(project.setupError).toBeUndefined();
        expect(project.catalog.has(coordinatorAgent.id)).toBe(true);
        const metadata = await project.rpc.bootstrap();
        expect(metadata).toMatchObject({ authority: "held" });
        expect(metadata).not.toHaveProperty("dataDir");
        expect(metadata.reason).toContain("absolute");
        expect(
          BackseatRpc.methods.bootstrap.output["~standard"].validate(metadata),
        ).toEqual({ value: metadata });
      } finally {
        await project.close();
      }
    }
    {
      const directory = await mkdtemp(
        resolve(".opencode/backseat/unsafe-registration-"),
      );
      await chmod(directory, 0o755);
      const project = await registeredCoordinator(false, undefined, directory);
      try {
        expect(project.setupError).toBeUndefined();
        expect(project.catalog.has(coordinatorAgent.id)).toBe(true);
        expect((await project.rpc.bootstrap()).authority).toBe("held");
        expect(
          await readFile(`${directory}/state.json`, "utf8").catch(
            () => undefined,
          ),
        ).toBeUndefined();
      } finally {
        await project.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
    {
      const directory = await mkdtemp(
        resolve(".opencode/backseat/held-registration-"),
      );
      const owner = new CoordinatorOwnership(
        directory,
        "existing-owner",
        createFilesystemOwnershipPort(async () => {}),
      );
      expect(await owner.claim()).toBe("owned");
      const project = await registeredCoordinator(false, undefined, directory);
      try {
        expect(project.setupError).toBeUndefined();
        expect(project.catalog.has(coordinatorAgent.id)).toBe(true);
        expect((await project.rpc.bootstrap()).authority).toBe("held");
        expect(
          await readFile(`${directory}/state.json`, "utf8").catch(
            () => undefined,
          ),
        ).toBeUndefined();
      } finally {
        await project.close();
        await owner.dispose(async () => {});
        await rm(directory, { recursive: true, force: true });
      }
    }
    for (const dataDir of ["", "relative/store"])
      expect(() =>
        resolveDataDirectory({ dataDir }, { home: "/users/example" }),
      ).toThrow("absolute");
    const root = resolve(".opencode/backseat");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const fixture = await mkdtemp(`${root}/unsafe-store-`);
    try {
      for (const mode of [0o777, 0o757]) {
        const parent = `${fixture}/public-${mode}`;
        await mkdir(parent);
        await chmod(parent, mode);
        await expect(openSharedStorage(`${parent}/store`)).rejects.toThrow(
          "Shared storage is unsafe or incomplete; coordination held",
        );
      }
      const sticky = `${fixture}/sticky`;
      const untrusted = `${sticky}/untrusted`;
      await mkdir(sticky, { mode: 0o1777 });
      await chmod(sticky, 0o1777);
      await mkdir(untrusted, { mode: 0o775 });
      const openDirectory = filesystem.open;
      const foreignChild = spyOn(filesystem, "open").mockImplementation(
        async (...args) => {
          const file = await openDirectory(...args);
          if (
            (await file.stat()).isDirectory() &&
            (await filesystem.realpath(`/proc/self/fd/${file.fd}`)) ===
              untrusted
          ) {
            const nativeStat = file.stat.bind(file);
            spyOn(file, "stat").mockImplementation((async () =>
              Object.assign(await nativeStat(), {
                uid: process.getuid!() + 1,
              })) as typeof file.stat);
          }
          return file;
        },
      );
      try {
        await expect(openSharedStorage(`${untrusted}/store`)).rejects.toThrow(
          "Shared storage is unsafe or incomplete; coordination held",
        );
      } finally {
        foreignChild.mockRestore();
      }
      const original = `${fixture}/original`;
      await mkdir(original, { mode: 0o700 });
      const anchored = await sharedStorageModule.openAnchoredDirectory(
        `${original}/store`,
      );
      try {
        await rename(original, `${fixture}/moved`);
        await mkdir(original);
        await mkdir(`${original}/store`, { mode: 0o700 });
        await expect(anchored.validate()).rejects.toThrow(
          "Shared storage is unsafe or incomplete; coordination held",
        );
      } finally {
        await anchored.close();
      }
      for (const failure of [
        "corrupt",
        "missing",
        "symlink",
        "hardlink",
        "mode",
        "directory",
        "interrupted",
      ] as const) {
        const directory = `${fixture}/${failure}`;
        const storage = await openSharedStorage(directory);
        await storage.set("limits", { followUps: 2 });
        await storage.close();
        const file = `${directory}/state.json`;
        if (failure === "corrupt") await writeFile(file, "{broken");
        if (failure === "missing" || failure === "symlink") await rm(file);
        if (failure === "symlink") {
          await writeFile(`${fixture}/target`, "unchanged");
          await symlink(`${fixture}/target`, file);
        }
        if (failure === "hardlink") await link(file, `${fixture}/linked-state`);
        if (failure === "mode") await chmod(file, 0o644);
        if (failure === "directory") await chmod(directory, 0o755);
        if (failure === "interrupted")
          await writeFile(`${directory}/.publish-interrupted`, "unfinished", {
            mode: 0o600,
          });
        await expect(openSharedStorage(directory)).rejects.toThrow();
        if (failure === "symlink")
          expect(await readFile(`${fixture}/target`, "utf8")).toBe("unchanged");
      }
      const nativeOpen = filesystem.open;
      const opened = spyOn(filesystem, "open").mockImplementation(
        async (...args) => {
          const file = await nativeOpen(...args);
          if (
            (await file.stat()).isDirectory() &&
            (await filesystem.realpath(`/proc/self/fd/${file.fd}`)) === fixture
          )
            spyOn(file, "sync").mockRejectedValue(
              new Error("Parent directory synchronization failed"),
            );
          return file;
        },
      );
      try {
        for (let attempt = 0; attempt < 2; attempt++)
          await expect(
            openSharedStorage(`${fixture}/parent-sync`),
          ).rejects.toThrow("Parent directory synchronization failed");
      } finally {
        opened.mockRestore();
      }
      for (const [index, value] of [
        "a".repeat(32 * 1024 * 1024),
        { invalid: undefined },
        { number: Number.NaN },
        Array.from({ length: 80 }).reduce<unknown>((value) => [value], null),
      ].entries()) {
        const storage = await openSharedStorage(`${fixture}/bounded-${index}`);
        try {
          await expect(storage.set("oversized", value)).rejects.toThrow();
        } finally {
          await storage.close();
        }
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
async function registeredCoordinator(
  passive = false,
  configured?: NativeAgent,
  dataDir?: string,
  sessions = new Map<string, string>(),
  faults: {
    failHook?: string;
    ask?: () => Promise<void>;
    catalog?: () => Promise<void>;
    get?: () => Promise<void>;
    hook?: (name: string) => Promise<void>;
    stream?: () => AsyncIterable<never>;
    native?: OpenCodeClient;
    unavailableStore?: boolean;
  } = {},
) {
  const root = resolve(".opencode/backseat");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(`${root}/agent-test-`);
  const worker = `${home}/worker`;
  await mkdir(worker);
  sessions.set(home, passive ? worker : home);
  const catalog = new Map<string, NativeAgent>(
    configured ? [[configured.id, structuredClone(configured)]] : [],
  );
  const values = new Map<string, unknown>();
  const defaults: unknown[] = [];
  const disposedHooks: string[] = [];
  let transforms = 0,
    disposed = 0;
  let replay: (() => void) | undefined;
  let contextHook: ((event: SessionContext) => Promise<void>) | undefined;
  let executionHook:
    ((event: NativeExecutionEvent) => Promise<void>) | undefined;
  let sessionAgent: string | undefined = coordinatorAgent.id;
  const dispatched: string[] = [];
  const nativeTools = new Map<string, NativeTool>();
  let failCatalog = false;
  let nativeRpc:
    | {
        bootstrap(): Promise<import("../src/rpc.ts").CoordinatorBootstrap>;
      }
    | undefined;
  const registration = { dispose: async () => {} };
  const context = {
    app: { version: "2.2.5" },
    options: { dataDir: dataDir ?? `${home}/data` },
    location: { directory: passive ? worker : home },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        await faults.get?.();
        return {
          id: sessionID,
          projectID: sessions.get(sessionID) ?? home,
          ...(sessionAgent ? { agent: sessionAgent } : {}),
          location: {
            directory: sessions.get(sessionID) ?? (passive ? worker : home),
          },
          time: { created: 1, updated: 1 },
        };
      },
      hook: async (
        name: string,
        callback: (event: SessionContext) => Promise<void>,
      ) => {
        await faults.hook?.(name);
        if (name === faults.failHook) throw new Error("Injected setup failure");
        if (name === "context") contextHook = callback;
        return {
          dispose: async () => {
            disposedHooks.push(name);
          },
        };
      },
    },
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        if (faults.stream) {
          yield* faults.stream();
          return;
        }
        await new Promise<void>((done) =>
          signal.aborted
            ? done()
            : signal.addEventListener("abort", () => done(), { once: true }),
        );
      },
    },
    permission: {
      hook: async () => registration,
      assert: async () => {
        await faults.ask?.();
      },
    },
    rpc: {
      register: async (_definition: unknown, handlers: typeof nativeRpc) => {
        nativeRpc = handlers;
        return registration;
      },
    },
    tool: {
      transform: async (transform: (editor: ToolEditor) => void) => {
        transform({
          namespace() {},
          add(tool: NativeTool) {
            nativeTools.set(
              tool.options?.namespace
                ? `${tool.options.namespace}_${tool.name}`
                : tool.name,
              tool,
            );
          },
        } as unknown as ToolEditor);
        return registration;
      },
      hook: async (
        name: string,
        callback: (event: NativeExecutionEvent) => Promise<void>,
      ) => {
        if (name === "execute.before") executionHook = callback;
        return {
          dispose: async () => {
            disposedHooks.push(`tool.${name}`);
          },
        };
      },
    },
    agent: {
      async list(input?: { location?: { directory?: string } }) {
        await faults.catalog?.();
        if (failCatalog) throw new Error("Unavailable catalog");
        return {
          location: {
            directory: input?.location?.directory ?? (passive ? worker : home),
          },
          data: [...catalog.values()],
        };
      },
      async transform(
        callback: Parameters<Plugin.Context["agent"]["transform"]>[0],
      ) {
        transforms++;
        const editor: AgentEditor = {
          list: () => [...catalog.values()],
          get: (id) => catalog.get(id),
          default: (id) => {
            defaults.push(id);
          },
          remove: (id) => {
            catalog.delete(id);
          },
          update(id, change) {
            const value =
              catalog.get(id) ??
              ({
                id,
                name: id,
                mode: "primary",
                hidden: false,
                permissions: [{ action: "*", resource: "*", effect: "allow" }],
                request: { settings: {}, headers: {}, body: {} },
              } as NativeAgent);
            catalog.set(id, value);
            change(value);
            value.id = id as NativeAgent["id"];
          },
        };
        replay = () => callback(editor);
        replay();
        return {
          dispose: async () => {
            disposed++;
            catalog.clear();
          },
        };
      },
    },
  } as unknown as Plugin.Context;
  let setupError: unknown;
  const nativeFactory = nativeConnectionModule.createNativeConnection;
  const nativeStub = spyOn(
    nativeConnectionModule,
    "createNativeConnection",
  ).mockImplementation((options) => {
    const connection = nativeFactory({
      ...options,
      registration: async () => undefined,
    });
    if (faults.native)
      connection.read = (operation) =>
        operation(faults.native!, new AbortController().signal);
    return connection;
  });
  const storeStub = faults.unavailableStore
    ? spyOn(sharedStorageModule, "openSharedStorage").mockRejectedValue(
        new Error("Unavailable store fixture"),
      )
    : undefined;
  const close = await Promise.resolve(nativePlugin.setup(context)).catch(
    (error) => {
      setupError = error;
    },
  );
  nativeStub.mockRestore();
  storeStub?.mockRestore();
  return {
    catalog,
    coordinatorID: home,
    setupError,
    defaults,
    disposedHooks,
    dispatched,
    async invoke(
      tool: string,
      input: unknown = {},
      signal = new AbortController().signal,
    ) {
      const event = {
        tool,
        sessionID: home,
        agent: sessionAgent!,
        messageID: "coordinator-message",
        id: "tool-call",
        input,
      } as NativeExecutionEvent;
      await executionHook?.(event);
      const selected = nativeTools.get(tool);
      if (!selected) throw new Error("Unregistered tool");
      return selected.execute(input, {
        ...event,
        signal,
        progress: async () => {},
      });
    },
    setAgent: (agent: string | undefined) => {
      sessionAgent = agent;
    },
    async execute(tool: string, overrides: Partial<NativeExecutionEvent> = {}) {
      const event = {
        tool,
        sessionID: home,
        agent: sessionAgent,
        messageID: "coordinator-message",
        id: "tool-call",
        input: {},
        ...overrides,
      } as NativeExecutionEvent;
      await executionHook?.(event);
      dispatched.push(tool);
    },
    replay: () => replay?.(),
    transforms: () => transforms,
    disposed: () => disposed,
    get rpc() {
      if (!nativeRpc) throw new Error("Native handlers not registered");
      return nativeRpc;
    },
    async tools(agent: string, unavailable = false, denied: string[] = []) {
      failCatalog = unavailable;
      const event = {
        agent,
        sessionID: home,
        tools: Object.fromEntries(
          [...COORDINATOR_TOOL_IDS, "skill", "shell"]
            .filter((name) => !denied.includes(name))
            .map((name) => [
              name,
              { description: name, input: { type: "object" } },
            ]),
        ),
      } as unknown as SessionContext;
      await contextHook?.(event);
      return Object.keys(event.tools).sort();
    },
    async close() {
      try {
        if (typeof close === "function") await close();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  };
}

// spec: openspec/specs/worker-coordination/spec.md
describe("Bundled conversational coordinator", () => {
  it("Rejects disallowed coordinator tool execution", async () => {
    const f = await registeredCoordinator();
    try {
      f.catalog.get(coordinatorAgent.id)!.permissions.push(...inheritedPolicy);
      for (const tool of [
        "shell",
        "read",
        "edit",
        "backseat_inspect",
        "backseat_control",
        "backseat_unregistered",
        "skill",
        "permission.reply",
        "form.reply",
        "webfetch",
        "subagent",
      ])
        await expect(f.execute(tool)).rejects.toThrow("Coordinator tool");
      await expect(
        f.execute("shell", {
          input: { tool: "backseat_list_sessions", agent: "engineer" },
        }),
      ).rejects.toThrow("Coordinator tool");
      expect(f.dispatched).toEqual([]);
      for (const tool of COORDINATOR_TOOL_IDS) await f.execute(tool);
      expect(f.dispatched).toEqual([...COORDINATOR_TOOL_IDS]);
      await f.execute("read", {
        agent: "engineer" as NativeExecutionEvent["agent"],
      });
      f.setAgent("engineer");
      await expect(
        f.execute("backseat_list_sessions", {
          agent: coordinatorAgent.id as NativeExecutionEvent["agent"],
        }),
      ).rejects.toThrow("Coordinator");
      f.setAgent(coordinatorAgent.id);
      await expect(
        f.execute("backseat_list_sessions", {
          sessionID: "" as NativeExecutionEvent["sessionID"],
        }),
      ).rejects.toThrow("Coordinator");
      await f.tools(coordinatorAgent.id, true);
      await expect(f.execute("backseat_list_sessions")).rejects.toThrow(
        "Coordinator",
      );
      await f.execute("read", {
        agent: "engineer" as NativeExecutionEvent["agent"],
      });
      await f.tools(coordinatorAgent.id, false);
      f.catalog.delete(coordinatorAgent.id);
      await expect(f.execute("question")).rejects.toThrow("Coordinator");
      f.catalog.set(coordinatorAgent.id, {
        ...coordinatorDefinition,
      } as NativeAgent);
      f.catalog.get(coordinatorAgent.id)!.system = "User-controlled role";
      await f.execute("shell");
      f.setAgent("engineer");
      await f.execute("read");
      expect(f.dispatched.slice(-2)).toEqual(["shell", "read"]);
    } finally {
      await f.close();
    }
    expect(f.disposedHooks).toContain("tool.execute.before");
    await expect(
      f.execute("backseat_list_sessions", {
        agent: coordinatorAgent.id as NativeExecutionEvent["agent"],
      }),
    ).rejects.toThrow("Coordinator");
    let lookups = 0;
    const unrelated = await registeredCoordinator(
      false,
      undefined,
      undefined,
      new Map(),
      {
        get: async () => {
          lookups++;
          throw new Error("Unrelated session lookup is unavailable");
        },
      },
    );
    try {
      await unrelated.execute("read", {
        agent: "engineer" as NativeExecutionEvent["agent"],
      });
      expect(unrelated.dispatched).toEqual(["read"]);
      expect(lookups).toBe(0);
      await expect(
        unrelated.execute("read", {
          agent: "" as NativeExecutionEvent["agent"],
        }),
      ).rejects.toThrow("Coordinator");
    } finally {
      await unrelated.close();
    }
    const sessions = new Map<string, string>();
    let pause = false;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((done) => {
      entered = done;
    });
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    const moved = await registeredCoordinator(
      false,
      undefined,
      undefined,
      sessions,
      {
        catalog: async () => {
          if (pause) {
            entered();
            await waiting;
          }
        },
      },
    );
    try {
      pause = true;
      const execution = moved.execute("backseat_list_sessions");
      await ready;
      sessions.set(moved.coordinatorID, `${moved.coordinatorID}/worker`);
      release();
      await expect(execution).rejects.toThrow("Coordinator");
      expect(moved.dispatched).toEqual([]);
    } finally {
      release();
      await moved.close();
    }
  });
  it("Registers the coordinator in every enabled project", async () => {
    for (const passive of [false, true]) {
      const f = await registeredCoordinator(passive);
      try {
        expect(f.catalog.has("backseat-coordinator")).toBe(true);
        {
          const agent = structuredClone(f.catalog.get("backseat-coordinator"));
          expect(agent).toMatchObject({
            id: "backseat-coordinator",
            mode: "primary",
            hidden: false,
          });
          expect(agent).not.toHaveProperty("model");
          f.replay();
          expect(f.catalog.get("backseat-coordinator")).toEqual(agent);
          expect(f.defaults).toEqual([]);
          f.catalog
            .get(coordinatorAgent.id)!
            .permissions.push(...inheritedPolicy);
          expect(await f.tools(coordinatorAgent.id)).toEqual(
            [...COORDINATOR_TOOL_IDS].sort(),
          );
        }
      } finally {
        await f.close();
      }
      expect(f.disposed()).toBe(1);
    }
  });
  it("Preserves a configured coordinator agent", async () => {
    const configured = {
      id: "backseat-coordinator",
      name: "My coordinator",
      mode: "primary",
      hidden: false,
      system: "My instructions",
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
      model: { providerID: "provider", id: "model" },
      request: { settings: {}, headers: {}, body: {} },
    } as NativeAgent;
    const definitions = [
      { definition: configured, exact: false },
      { definition: { ...coordinatorDefinition, mode: "all" }, exact: false },
      { definition: { ...coordinatorDefinition, hidden: true }, exact: false },
      {
        definition: {
          ...coordinatorDefinition,
          permissions: coordinatorDefinition.permissions.toReversed(),
        },
        exact: false,
      },
      {
        definition: {
          ...coordinatorDefinition,
          permissions: coordinatorDefinition.permissions.slice(1),
        },
        exact: false,
      },
      {
        definition: {
          ...coordinatorDefinition,
          permissions: [
            ...coordinatorDefinition.permissions,
            ...inheritedPolicy,
          ],
        },
        exact: true,
      },
    ];
    for (const { definition, exact } of definitions) {
      const f = await registeredCoordinator(false, definition as NativeAgent);
      try {
        f.replay();
        expect(f.catalog.get(definition.id)).toEqual(definition as NativeAgent);
        expect(f.defaults).toEqual([]);
        expect(await f.tools(definition.id)).toEqual(
          exact
            ? [...COORDINATOR_TOOL_IDS].sort()
            : [...COORDINATOR_TOOL_IDS, "shell", "skill"].sort(),
        );
      } finally {
        await f.close();
      }
    }
  });
  it("Preserves native approval for conversational control", async () => {
    const f = await registeredCoordinator();
    try {
      await expect(f.invoke("backseat_list_sessions")).rejects.toThrow(
        "Native service",
      );
      const permissions =
        f.catalog.get("backseat-coordinator")?.permissions ?? [];
      const effect = (action: string) =>
        permissions
          .filter(
            (rule) =>
              rule.action === "*" ||
              rule.action === action ||
              (rule.action === "backseat.*" && action.startsWith("backseat.")),
          )
          .at(-1)?.effect;
      for (const tool of COORDINATOR_TOOL_IDS)
        expect(effect(tool)).toBe("allow");
      for (const action of [
        "backseat.start_supervision",
        "backseat.create",
        "backseat.dispatch",
        "backseat.adopt",
        "backseat.takeover",
        "backseat.recover",
        "backseat.resume",
      ])
        expect(effect(action)).toBe("ask");
      for (const action of [
        "shell",
        "read",
        "edit",
        "webfetch",
        "subagent",
        "permission.reply",
        "form.reply",
      ])
        expect(effect(action)).toBe("deny");
      expect(await f.tools(coordinatorAgent.id)).toEqual(
        [...COORDINATOR_TOOL_IDS].sort(),
      );
      const unrelated = [...COORDINATOR_TOOL_IDS, "shell", "skill"].sort();
      expect(await f.tools("engineer")).toEqual(unrelated);
      const bundled = f.catalog.get(coordinatorAgent.id)!;
      f.catalog.set(coordinatorAgent.id, {
        ...bundled,
        permissions: [...bundled.permissions, ...inheritedPolicy],
      });
      expect(await f.tools(coordinatorAgent.id)).toEqual(
        [...COORDINATOR_TOOL_IDS].sort(),
      );
      expect(
        await f.tools(coordinatorAgent.id, false, ["backseat_dispatch_task"]),
      ).toEqual(
        [...COORDINATOR_TOOL_IDS]
          .filter((id) => id !== "backseat_dispatch_task")
          .sort(),
      );
      f.catalog.set(coordinatorAgent.id, {
        ...bundled,
        system: "User-defined role",
      });
      expect(await f.tools(coordinatorAgent.id)).toEqual(unrelated);
      f.catalog.set(coordinatorAgent.id, bundled);
      expect(await f.tools(coordinatorAgent.id, true)).toEqual([]);
    } finally {
      await f.close();
    }
    const worker = {
      id: "native-worker",
      title: "Native worker",
      agent: goal.agent,
      location: { directory: goal.location },
      time: { created: 1, updated: 1 },
    };
    const native = {
      form: {
        list: async () => ({ location: worker.location, data: [] }),
      },
      session: {
        list: async () => ({ data: [worker], cursor: {} }),
        get: async () => worker,
        active: async () => ({}),
        inbox: { list: async () => [] },
        form: {
          list: async () => [],
          get: async () => {
            throw new Error("Unexpected form");
          },
        },
      },
      project: {
        list: async () => [
          {
            id: "native-project",
            canonical: worker.location.directory,
            sandboxes: [],
            name: "Project",
          },
        ],
      },
      agent: {
        list: async () => ({
          location: { directory: worker.location.directory },
          data: [
            coordinatorDefinition,
            { id: goal.agent, mode: "all", hidden: false },
          ],
        }),
      },
      permission: {
        request: {
          list: async () => ({
            location: { directory: worker.location.directory },
            data: [],
          }),
        },
      },
    } as unknown as OpenCodeClient;
    const unavailable = await registeredCoordinator(
      false,
      undefined,
      undefined,
      new Map(),
      { native, unavailableStore: true },
    );
    worker.location.directory = unavailable.coordinatorID;
    try {
      expect(
        (await unavailable.invoke("backseat_list_sessions")).output,
      ).toMatchObject({
        available: true,
        partial: false,
        sessions: [
          {
            id: worker.id,
            location: worker.location.directory,
            status: "inactive",
          },
        ],
      });
      expect(
        (await unavailable.invoke("backseat_list_projects")).output,
      ).toMatchObject({ projects: [{ location: worker.location.directory }] });
      expect(
        (
          await unavailable.invoke("backseat_list_agents", {
            location: worker.location.directory,
          })
        ).output,
      ).toMatchObject({ agents: [goal.agent] });
      for (const input of [
        { view: "invalid" },
        { cursor: "cursor" },
        { location: worker.location.directory },
      ])
        await expect(
          unavailable.invoke("backseat_list_projects", input),
        ).rejects.toThrow();
      await expect(
        unavailable.invoke("backseat_list_agents", {
          location: "relative-project",
        }),
      ).rejects.toThrow();
      await expect(
        unavailable.invoke("backseat_dispatch_task", {
          taskID: goal.id,
          text: "Approved assignment",
          scope: goal.scope,
        }),
      ).rejects.toThrow("recovery required");
      await expect(
        unavailable.invoke("backseat_dispatch_task", {
          operation: "invalid",
          taskID: goal.id,
        }),
      ).rejects.toThrow();
      await expect(unavailable.invoke("backseat_list_tasks")).rejects.toThrow(
        "task store",
      );
      unavailable.setAgent("engineer");
      await expect(
        unavailable.invoke("backseat_list_sessions"),
      ).rejects.toThrow();
    } finally {
      await unavailable.close();
    }
    await expect(
      unavailable.invoke("backseat_dispatch_task", {
        taskID: goal.id,
        text: "Approved assignment",
        scope: goal.scope,
      }),
    ).rejects.toThrow("Project adapter is unavailable");
    for (const role of [
      "engineer",
      "collision",
      "agentless",
      "drift",
      "permissions",
      "mode",
      "hidden",
    ]) {
      const fixture = await backendFixture();
      const get = fixture.host.session.get;
      fixture.host.session.get = async (input) => {
        const session = { ...(await get(input)) };
        if (role === "agentless") delete session.agent;
        else session.agent = role === "engineer" ? role : coordinatorAgent.id;
        return session;
      };
      fixture.host.agent.list = async () => ({
        location: { directory: "/projects/home" },
        data:
          role === "drift"
            ? []
            : [
                {
                  ...coordinatorDefinition,
                  ...(role === "permissions"
                    ? {
                        permissions: [
                          {
                            action: "*",
                            resource: "*",
                            effect: "allow" as const,
                          },
                        ],
                      }
                    : role === "mode"
                      ? { mode: "all" as const }
                      : role === "hidden"
                        ? { hidden: true }
                        : { system: "User role" }),
                },
              ],
      });
      try {
        const before = fixture.asks.length;
        await expect(
          fixture.backend.startSupervision(nativeIdentity()),
        ).rejects.toThrow("Backseat Coordinator");
        expect(fixture.asks).toHaveLength(before);
      } finally {
        await fixture.backend.dispose();
      }
    }
  });
  it("Preserves cross-project control under inherited policy", async () => {
    const f = await backendFixture([], 0, false, false);
    try {
      const locations: unknown[] = [];
      const catalog = f.host.agent.list;
      f.host.agent.list = async (input) => {
        locations.push(input?.location?.directory);
        const result = await catalog(input);
        return {
          ...result,
          data: result.data.map((agent) =>
            agent.id === coordinatorAgent.id
              ? {
                  ...agent,
                  permissions: [...agent.permissions, ...inheritedPolicy],
                }
              : agent,
          ),
        };
      };
      f.host.nativeSend = async (input, sendID, coordinatorLocation) => {
        expect(input.location).toBe(goal.location);
        expect(coordinatorLocation).toBe("/projects/home");
        return f.host.session.prompt({
          sessionID: input.sessionID,
          id: sendID,
          text: input.text,
        });
      };
      const result = await f.backend.sendSession(
        {
          sessionID: "selected-worker",
          location: goal.location,
          agent: goal.agent,
          text: "Run the approved endpoint checks",
        },
        nativeIdentity(),
      );
      expect(result.status).toBe("admitted");
      expect(f.asks).toEqual(["backseat.send_session"]);
      expect(f.effects).toEqual(["prompt"]);
      expect(locations).toContain("/projects/home");
      expect(
        parseCoordinatorState(f.root()).sessionDeliveries![0],
      ).toMatchObject({
        sessionID: "selected-worker",
        location: goal.location,
        coordinatorID: "coordinator",
      });
      expect((await f.backend.inspect()).bindings).toEqual([]);
    } finally {
      await f.backend.dispose();
    }
  });
  it("Rejects coordinator worker assignments", async () => {
    for (const bundled of [true, false]) {
      for (const operation of ["create", "adopt"] as const) {
        const f = await backendFixture();
        const agent = {
          ...coordinatorAgent,
          system: bundled ? coordinatorAgent.system : "User-controlled role",
          request: { settings: {}, headers: {}, body: {} },
          permissions: coordinatorAgent.permissions
            .map((rule) => ({
              ...rule,
            }))
            .concat(inheritedPolicy),
        };
        f.host.agent.list = async (input) => ({
          location: { directory: input?.location?.directory ?? goal.location },
          data:
            input?.location?.directory === "/projects/home"
              ? [coordinatorDefinition]
              : [agent],
        });
        const get = f.host.session.get;
        f.host.session.get = async (input) => ({
          ...(await get(input)),
          agent:
            input.sessionID === "coordinator" ? coordinatorAgent.id : agent.id,
        });
        const selected = { ...goal, agent: coordinatorAgent.id };
        try {
          const action = f.control(
            operation,
            goal.id,
            operation === "create"
              ? selected
              : { goal: selected, workerID: "existing-worker" },
          );
          if (bundled) {
            await expect(action).rejects.toThrow("Unavailable target agent");
            expect(
              f.effects.filter((e) => ["create", "prompt"].includes(e)),
            ).toEqual([]);
            expect((await f.backend.inspect()).bindings).toEqual([]);
          } else expect((await action).accepted).toBe(true);
        } finally {
          await f.backend.dispose();
        }
      }
    }
  });
});

async function backendFixture(
  bindings: WorkerBinding[] = [],
  snapshotCount = 0,
  unresolved = false,
  attach = true,
  completions: import("../src/state.ts").CompletionRecord[] = [],
  initial?: import("../src/state.ts").CoordinatorState,
) {
  const home = "/projects/home";
  let root: unknown = initial ?? {
    version: 1,
    bindings,
    snapshots: Array.from({ length: snapshotCount }, (_, n) => ({
      id: `shared-${n}`,
      version: 1,
      content: "approved",
      group: "team",
      recipients: bindings.map((b) => b.id),
    })),
    intents: unresolved
      ? [
          {
            intent: {
              id: "initial",
              taskID: bindings[0]!.id,
              workerID: bindings[0]!.workerID,
              identity: "initial",
              text: "Approved initial task",
              nonprogress: 0,
              status: "ambiguous",
            },
            revision: bindings[0]!.revision,
            epoch: bindings[0]!.epoch,
            generation: 0,
            createdAt: 1,
            kind: "initial",
          },
        ]
      : [],
    completions,
  };
  const values = new Map<string, unknown>();
  const asks: string[] = [],
    effects: string[] = [];
  let approval = async () => {};
  let directory = goal.location;
  let failedWrite = false;
  const messages: SessionMessageInfo[] = [
    {
      id: "assistant-1",
      type: "assistant",
      agent: goal.agent,
      model: { id: "model", providerID: "provider" },
      time: { created: 1, completed: 1 },
      finish: "stop",
      content: [{ type: "text", text: "Task verification complete" }],
    },
    { id: "idle-1", type: "idle", time: { created: 1 }, outcome: "succeeded" },
  ];
  const host: NativeBackendHost = {
    readInvocation: async (identity) => ({
      messageID: identity.messageID,
      createdAt: 1000,
    }),
    session: {
      async get({ sessionID }) {
        return {
          id: sessionID,
          agent: sessionID === "coordinator" ? coordinatorAgent.id : goal.agent,
          projectID: "project",
          location: {
            directory: sessionID === "coordinator" ? home : directory,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          outcome: "succeeded",
          time: { created: 1, updated: 1, busy: 0, idle: 1 },
        };
      },
      async context() {
        return structuredClone(messages);
      },
      async create() {
        effects.push("create");
        return host.session.get({ sessionID: `worker-${effects.length}` });
      },
      async prompt(input) {
        effects.push("prompt");
        return { id: input.id, sessionID: input.sessionID } as Awaited<
          ReturnType<NativeBackendHost["session"]["prompt"]>
        >;
      },
    },
    agent: {
      async list(input) {
        return {
          location: {
            directory: input?.location?.directory === home ? home : directory,
          },
          data: [
            coordinatorDefinition,
            {
              id: goal.agent,
              name: "Engineer",
              mode: "all",
              hidden: false,
              permissions: [],
              request: { settings: {}, headers: {}, body: {} },
            },
          ],
        };
      },
    },
    permission: {
      async assert(input) {
        asks.push(input.action);
        await approval();
      },
    },
    storage: {
      async get(key) {
        return structuredClone(
          key.endsWith(":state") ? root : values.get(key),
        ) as Awaited<ReturnType<NativeBackendHost["storage"]["get"]>>;
      },
      async set(key, value) {
        if (failedWrite) throw new Error("Storage failed");
        if (key.endsWith(":state")) root = structuredClone(value);
        else values.set(key, structuredClone(value));
      },
    },
    canonical: async (path) => path,
    generate: async () => {
      effects.push("generate");
      return {};
    },
    observeNative: async (binding, snapshots, snapshot) => {
      const built = buildContext(
        binding,
        {
          taskID: binding.id,
          workerID: binding.workerID,
          turn: 1,
          entries: [
            {
              id: "fixture-observation",
              kind: "worker",
              text: "No task evidence supplied by this fixture",
            },
          ],
        },
        snapshots,
        40000,
      );
      if (built.status !== "ready") throw new Error(built.reason);
      return {
        turn: 1,
        state: binding.status === "active" ? "running" : "settled",
        asks: [],
        snapshot,
        context: built.context,
      };
    },
  };
  const backend = await createNativeBackend(
    host,
    new CoordinatorOwnership(home, "backend-owner", {
      inspect: async () => ({ safe: true }),
      acquire: async () => true,
      release: async () => {
        effects.push("release");
      },
      approveRecovery: async () => {},
      recover: async () => {},
    }),
    home,
  );
  const { generation } = attach
    ? await backend.startSupervision(nativeIdentity())
    : { generation: 0 };
  const control = async (
    operation: "create" | "adopt" | "hold" | "resume" | "share",
    taskID: string,
    body: unknown,
  ) => {
    return backend.nativeControl(
      operation,
      taskID,
      operation === "resume" ? {} : body,
      nativeIdentity(),
    );
  };
  const observation = (b: WorkerBinding) => {
    const snapshot = {
      dataDir: home,
      location: b.location,
      sessionID: b.workerID,
      incarnation: "incarnation",
      sequence: 1,
      invalidationVersion: 0,
      messageIDs: messages.map((m) => m.id),
      contextFingerprint: fingerprint(messages),
      nativeBoundary: messages.at(-1)!.id,
      background: [],
      publishedAt: Date.now(),
    };
    const prefix = `store:${encodeURIComponent(home)}:worker:${encodeURIComponent(b.location)}`;
    values.set(`${prefix}:observer`, {
      incarnation: snapshot.incarnation,
      usable: true,
    });
    values.set(
      `${prefix}:${encodeURIComponent(b.workerID)}:snapshot`,
      snapshot,
    );
    return {
      reconciliation: {
        generation,
        workerID: b.workerID,
        revision: b.revision,
        epoch: b.epoch,
        snapshotFingerprint: fingerprint(snapshot),
        observedAt: Date.now(),
        state: "settled",
        asks: [],
      },
    };
  };
  return {
    backend,
    host,
    asks,
    effects,
    control,
    observation,
    values,
    messages,
    root: () => structuredClone(root),
    approve: (fn: () => Promise<void>) => {
      approval = fn;
    },
    move: () => {
      directory = "/projects/changed";
    },
    failWrite: (value = true) => {
      failedWrite = value;
    },
  };
}

// spec: openspec/specs/worker-coordination/spec.md
describe("Authorised shared-state inspection", () => {
  it("Bootstraps without disclosing task state", async () => {
    const f = await backendFixture([
      {
        ...goal,
        workerID: "worker",
        revision: 1,
        epoch: 1,
        status: "held",
        followups: 2,
        nonprogress: 0,
      },
    ]);
    try {
      expect(f.backend.bootstrap()).toEqual({
        dataDir: "/projects/home",
        authority: "owned",
      });
      f.failWrite();
      await expect(f.control("hold", goal.id, {})).rejects.toThrow(
        "Storage failed",
      );
      const metadata = f.backend.bootstrap();
      expect(metadata.authority).toBe("held");
      expect(Object.keys(metadata).sort()).toEqual([
        "authority",
        "dataDir",
        "reason",
      ]);
    } finally {
      await f.backend.dispose();
    }
  });
  it("Rejects unauthorised shared-state reads", async () => {
    for (const change of ["role", "catalog"] as const) {
      const f = await backendFixture([
        {
          ...goal,
          workerID: "worker",
          revision: 1,
          epoch: 1,
          status: "held",
          followups: 2,
          nonprogress: 0,
        },
      ]);
      try {
        const get = f.host.session.get;
        f.host.session.get = async (input) => ({
          ...(await get(input)),
          ...(change === "role" && input.sessionID === "coordinator"
            ? { agent: "engineer" }
            : {}),
        });
        if (change === "catalog")
          f.host.agent.list = async () => ({
            location: { directory: "/projects/home" },
            data: [],
          });
        await expect(f.backend.inspect(nativeIdentity())).rejects.toThrow();
        expect(f.backend.bootstrap()).toEqual({
          dataDir: "/projects/home",
          authority: "owned",
        });
        expect(f.effects).not.toContain("prompt");
      } finally {
        await f.backend.dispose();
      }
    }
  });
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Approved task binding", () => {
  it("Creates a worker at the selected location", async () => {
    const { host, events, starts, saved } = creationHost();
    const binding = await createWorker(goal, host);
    expect(binding?.workerID).toBe("worker-api");
    expect(binding?.location).toBe(goal.location);
    expect(binding?.agent).toBe(goal.agent);
    expect(events.indexOf("approval")).toBeLessThan(events.indexOf("create"));
    expect(events).toContain(`agent:${goal.location}:${goal.agent}`);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.sessionID).toBe("worker-api");
    expect(starts[0]?.text).toContain(goal.goal);
    expect(starts[0]?.text).toContain(goal.constraints[0]!);
    expect(saved[0]?.workerID).toBe("worker-api");

    const mutableGoal = structuredClone(goal);
    const second = creationHost();
    second.host.approve = async () => {
      mutableGoal.location = "/projects/unapproved";
    };
    const snapshotBinding = await createWorker(mutableGoal, second.host);
    expect(snapshotBinding.location).toBe(goal.location);
    const f = await backendFixture([], 0, false, false);
    try {
      await f.backend.nativeControl("create", goal.id, goal, {
        sessionID: "coordinator",
        agent: coordinatorAgent.id,
        messageID: "message",
        id: "create-call",
      });
      expect(f.effects).toEqual(["create", "prompt"]);
      expect((await f.backend.inspect()).bindings[0]?.location).toBe(
        goal.location,
      );
      expect(parseCoordinatorState(f.root()).intents[0]?.intent.status).toBe(
        "admitted",
      );
      expect((await f.backend.inspect()).observer).toBeUndefined();
    } finally {
      await f.backend.dispose();
    }
  });

  it("Rejects an unavailable or mismatched target", async () => {
    for (const options of [{ location: false }, { agent: false }]) {
      const { host, events, starts } = creationHost(options);
      await expect(createWorker(goal, host)).rejects.toThrow(
        "Unavailable target",
      );
      expect(events).not.toContain("create");
      expect(starts).toHaveLength(0);
    }
    for (const operation of ["create", "adopt"] as const)
      for (const failure of ["deny", "changed", "capacity"] as const) {
        const bindings =
          failure === "capacity"
            ? Array.from({ length: 8 }, (_, n) => ({
                ...goal,
                id: `task-${n}`,
                workerID: `owned-${n}`,
                revision: 1,
                epoch: 1,
                status: "held" as const,
                followups: 0,
                nonprogress: 0,
              }))
            : [];
        const f = await backendFixture(bindings);
        try {
          const before = (await f.backend.inspect()).bindings;
          f.approve(async () => {
            if (failure === "deny") throw new Error("Denied");
            if (failure === "changed") f.move();
          });
          await expect(
            f.control(
              operation,
              goal.id,
              operation === "create" ? goal : { goal, workerID: "existing" },
            ),
          ).rejects.toThrow();
          expect((await f.backend.inspect()).bindings).toEqual(before);
          expect((await f.backend.inspect()).supervision?.generation).toBe(1);
          expect(f.effects).toEqual([]);
          expect(f.asks).toHaveLength(failure === "capacity" ? 1 : 2);
        } finally {
          await f.backend.dispose();
        }
      }
  });
});

// Real-process contract regressions: the adapter, not flock in isolation.
// spec: openspec/specs/worker-coordination/spec.md
describe("Filesystem coordinator authority", () => {
  const adapterURL = new URL("../src/ownership.ts", import.meta.url).href;
  async function fixture() {
    const root = resolve(".opencode/backseat");
    await mkdir(root, { recursive: true, mode: 0o700 });
    return mkdtemp(`${root}/kernel-test-`);
  }
  function authority(
    home: string,
    owner: string,
    approval: (home: string, owner: string) => Promise<void> = async () => {},
  ) {
    return new CoordinatorOwnership(
      home,
      owner,
      createFilesystemOwnershipPort(approval),
    );
  }
  function childCode(home: string, owner: string, afterClaim: string) {
    return `import {CoordinatorOwnership,createFilesystemOwnershipPort} from ${JSON.stringify(adapterURL)};
      const a=new CoordinatorOwnership(${JSON.stringify(home)},${JSON.stringify(owner)},createFilesystemOwnershipPort(async()=>{}));
      console.log(await a.claim()); ${afterClaim}`;
  }
  async function child(home: string, owner: string, crash = false) {
    const code = childCode(
      home,
      owner,
      crash ? "process.exit(0);" : "await a.dispose(async()=>{});",
    );
    return runChild(code);
  }
  async function runChild(code: string) {
    const process = Bun.spawn([Bun.which("bun")!, "-e", code], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(process.stdout).text();
    const error = await new Response(process.stderr).text();
    expect(await process.exited, error).toBe(0);
    return output.trim();
  }

  function contender(home: string, owner: string) {
    const process = Bun.spawn(
      [
        Bun.which("bun")!,
        "-e",
        childCode(
          home,
          owner,
          "await Bun.stdin.text(); await a.dispose(async()=>{});",
        ),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    return {
      async result() {
        const reader = process.stdout.getReader();
        try {
          let output = "";
          const decoder = new TextDecoder();
          while (!output.includes("\n")) {
            const { value, done } = await reader.read();
            if (done) break;
            output += decoder.decode(value, { stream: true });
          }
          return output.trim();
        } finally {
          reader.releaseLock();
        }
      },
      async close() {
        process.stdin.end();
        const error = await new Response(process.stderr).text();
        expect(await process.exited, error).toBe(0);
      },
    };
  }

  it("Holds a competing or unsafe authority", async () => {
    await mockAuthority("competing");
    const home = await fixture();
    const first = authority(home, "first");
    try {
      expect(await first.claim()).toBe("owned");
      const lock = resolve(home, "ownership.lock");
      expect(
        await readFile(lock, "utf8").catch(() => "missing ownership record"),
      ).toContain('"owner":"first"');
      const inode = (await stat(lock)).ino;
      expect(await child(home, "independent")).toBe("held");
      await expect(
        first.dispose(async () => {
          throw new Error("Drain failed");
        }),
      ).rejects.toThrow("Drain failed");
      expect(await child(home, "after-drain-failure")).toBe("held");
      const unrelated = Bun.spawn(
        [Bun.which("bun")!, "-e", "await Bun.stdin.text()"],
        { stdin: "pipe", stdout: "ignore", stderr: "ignore" },
      );
      try {
        await first.dispose(async () => {
          expect(await child(home, "during-drain")).toBe("held");
        });
        expect(await child(home, "after-close")).toBe("owned");
      } finally {
        unrelated.stdin.end();
        await unrelated.exited;
      }
      expect((await stat(lock)).ino).toBe(inode);
      for (const unsafe of [
        "symlink",
        "mode",
        "malformed",
        "invalid-utf8",
        "oversized",
        "lock-mode",
        "lock-symlink",
        "hardlink",
      ]) {
        const target = await fixture();
        const blocked = authority(target, "blocked");
        try {
          const directory = target;
          if (unsafe === "symlink") {
            await rm(directory, { recursive: true });
            await symlink(home, directory);
          } else {
            if (unsafe === "mode") await chmod(directory, 0o777);
            if (unsafe === "malformed")
              await writeFile(
                resolve(directory, "ownership.lock"),
                "not-json",
                { mode: 0o600 },
              );
            if (unsafe === "invalid-utf8") {
              const record = {
                ...JSON.parse(await readFile(lock, "utf8")),
                owner: "invalid-marker",
              };
              const bytes = Buffer.from(JSON.stringify(record));
              bytes[bytes.indexOf("invalid-marker")] = 0xff;
              await writeFile(resolve(directory, "ownership.lock"), bytes, {
                mode: 0o600,
              });
            }
            if (unsafe === "oversized")
              await writeFile(
                resolve(directory, "ownership.lock"),
                " ".repeat(8193),
                { mode: 0o600 },
              );
            if (unsafe === "lock-mode")
              await writeFile(resolve(directory, "ownership.lock"), "", {
                mode: 0o644,
              });
            if (unsafe === "lock-symlink")
              await symlink(lock, resolve(directory, "ownership.lock"));
            if (unsafe === "hardlink")
              await link(lock, resolve(directory, "ownership.lock"));
          }
          expect(await blocked.claim(), unsafe).toBe("held");
          await expect(blocked.recover()).rejects.toThrow(
            "Recovery is not eligible",
          );
        } finally {
          await blocked.dispose(async () => {});
          await rm(target, { recursive: true, force: true });
        }
      }
      // Exercise our fail-closed mapping without altering the installed helper.
      const helperHome = await fixture();
      const realSpawn = subprocess.spawn;
      for (const failure of ["error", "exit"]) {
        const spawn = spyOn(subprocess, "spawn").mockImplementation((() => {
          const helper = new subprocess.ChildProcess();
          queueMicrotask(() => {
            if (failure === "error")
              helper.emit("error", new Error("Helper unavailable"));
            helper.emit("close", 2);
          });
          return helper;
        }) as typeof subprocess.spawn);
        try {
          expect(await authority(helperHome, `helper-${failure}`).claim()).toBe(
            "held",
          );
        } finally {
          spawn.mockRestore();
        }
      }
      expect(subprocess.spawn).toBe(realSpawn);
      expect(await child(helperHome, "helper-restored")).toBe("owned");
      await rm(helperHome, { recursive: true, force: true });

      const contenders = [
        contender(home, "concurrent-a"),
        contender(home, "concurrent-b"),
      ];
      try {
        expect(
          (await Promise.all(contenders.map((child) => child.result()))).sort(),
        ).toEqual(["held", "owned"]);
      } finally {
        await Promise.all(contenders.map((child) => child.close()));
      }

      const failedRelease = authority(home, "failed-release");
      expect(await failedRelease.claim()).toBe("owned");
      await chmod(lock, 0o644);
      await expect(failedRelease.dispose(async () => {})).rejects.toThrow(
        "Recovery is not eligible",
      );
      await chmod(lock, 0o600);
      await expect(failedRelease.dispose(async () => {})).rejects.toThrow(
        "Recovery is not eligible",
      );
      expect(
        await createFilesystemOwnershipPort(async () => {}).inspect(home),
      ).toEqual({
        safe: true,
        lock: { owner: "failed-release", running: true },
      });
      expect(await child(home, "after-release-failure")).toBe("held");
    } finally {
      await first.dispose(async () => {});
      await rm(home, { recursive: true, force: true });
    }
  });

  it("Fences an unloaded project without releasing other participants", async () => {
    {
      const directory = await mkdtemp(
        resolve(".opencode/backseat/observer-stop-"),
      );
      try {
        const output = await runChild(`
          import {spyOn} from "bun:test";
          import {promisePlugin} from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
          const nativePlugin=promisePlugin(()=>{});
          import * as ownership from ${JSON.stringify(new URL("../src/ownership.ts", import.meta.url).href)};
          const directory=${JSON.stringify(directory)};
          let finish, failing=false, unhandled=0, releases=0, fences=0;
          const ended=new Promise(resolve=>{finish=resolve;});
          const values=new Map();
          const registration={dispose:async()=>{}};
          const core={projects:new Map(),backend:{bootstrap:()=>({dataDir:directory,authority:"owned"}),fenceProject:async()=>{fences++;}},storage:{get:async key=>values.get(key),set:async(key,value)=>{if(failing)throw new Error("Injected observer invalidation failure");values.set(key,value);}},dispose:async()=>{}};
          const acquisition=spyOn(ownership,"acquireCoordinatorCore").mockResolvedValue({core,release:async()=>{releases++;}});
          process.on("unhandledRejection",()=>{unhandled++;});
          const close=await nativePlugin.setup({app:{version:"2.2.5"},options:{dataDir:directory},location:{directory},session:{hook:async()=>registration},event:{async *subscribe(){await ended;}},permission:{hook:async()=>registration},agent:{transform:async()=>registration},rpc:{register:async()=>registration},tool:{transform:async()=>registration,hook:async()=>registration}});
          failing=true;finish();
          await new Promise(resolve=>setImmediate(resolve));
          await new Promise(resolve=>setImmediate(resolve));
          const fenced=fences>0;
          let held=false;try{await close();}catch{held=true;}
          acquisition.mockRestore();
          process.stdout.write(JSON.stringify({unhandled,releases,held,fenced}));
        `);
        expect(JSON.parse(output)).toEqual({
          unhandled: 0,
          releases: 0,
          held: true,
          fenced: true,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    {
      let releases = 0;
      const acquisition = spyOn(
        ownershipModule,
        "acquireCoordinatorCore",
      ).mockResolvedValueOnce({
        core: {
          backend: {
            bootstrap: () => ({ authority: "held" }),
            fenceProject: async () => {
              throw new Error("Injected cleanup failure");
            },
          },
          projects: new Map(),
          storage: {},
          dispose: async () => {},
        },
        release: async () => {
          releases++;
        },
      } as unknown as Awaited<
        ReturnType<typeof ownershipModule.acquireCoordinatorCore>
      >);
      try {
        const project = await registeredCoordinator(
          false,
          undefined,
          undefined,
          new Map(),
          { failHook: "context" },
        );
        try {
          expect(project.setupError).toBeInstanceOf(AggregateError);
          const error = project.setupError as AggregateError;
          expect(error.errors[0]?.message).toBe("Injected setup failure");
          expect(error.errors[1]).toBeInstanceOf(AggregateError);
          expect(releases).toBe(0);
        } finally {
          await project.close();
        }
      } finally {
        acquisition.mockRestore();
      }
    }
    {
      const directory = await mkdtemp(
        resolve(".opencode/backseat/stream-eof-"),
      );
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const project = await registeredCoordinator(
        false,
        undefined,
        directory,
        new Map(),
        {
          stream: async function* () {
            await waiting;
          },
        },
      );
      try {
        await project.invoke("backseat_start_supervision");
        finish();
        let fenced = false;
        for (let sequence = 1; sequence <= 100 && !fenced; sequence++) {
          const stored = JSON.parse(
            await readFile(`${directory}/state.json`, "utf8"),
          ).values as Record<string, { usable?: boolean }>;
          fenced = Object.values(stored).some(
            (value) => value.usable === false,
          );
          if (!fenced)
            await new Promise<void>((resolve) => setTimeout(resolve, 2));
        }
        expect(fenced).toBe(true);
        const values = JSON.parse(
          await readFile(`${directory}/state.json`, "utf8"),
        ).values as Record<string, { usable?: boolean }>;
        expect(
          Object.values(values)
            .filter((value) => typeof value.usable === "boolean")
            .map((value) => value.usable),
        ).toEqual([false]);
      } finally {
        finish();
        await project.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
    for (const startup of ["unload", "failure"] as const) {
      const directory = await mkdtemp(
        resolve(".opencode/backseat/late-observer-"),
      );
      expect(await child(directory, "terminated-project", true)).toBe("owned");
      let enter!: () => void, finish!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const sessions = new Map<string, string>();
      const first = await registeredCoordinator(
        false,
        undefined,
        directory,
        sessions,
        {
          hook: async (name) => {
            if (name === "experimental.idle") {
              enter();
              await waiting;
              if (startup === "failure")
                throw new Error("Observer startup failed");
            }
          },
        },
      );
      const second = await registeredCoordinator(
        true,
        undefined,
        directory,
        sessions,
      );
      try {
        await first.invoke("backseat_recover_runtime");
        const attaching = first
          .invoke("backseat_start_supervision")
          .catch(() => undefined);
        await entered;
        const closing =
          startup === "unload" ? first.close() : Promise.resolve();
        finish();
        const [, attached] = await Promise.all([closing, attaching]);
        if (startup === "unload")
          expect(first.disposedHooks).toContain("experimental.idle");
        else {
          expect(attached?.output).toBeDefined();
          const values = JSON.parse(
            await readFile(`${directory}/state.json`, "utf8"),
          ).values as Record<string, { usable?: boolean }>;
          expect(
            Object.values(values)
              .filter((value) => typeof value.usable === "boolean")
              .map((value) => value.usable)
              .sort(),
          ).toEqual([false, true]);
        }
        expect((await second.rpc.bootstrap()).authority).toBe("owned");
      } finally {
        finish();
        await first.close();
        await second.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
    {
      const fixture = await backendFixture([
        {
          ...goal,
          workerID: "worker",
          revision: 1,
          epoch: 1,
          status: "held",
          followups: 0,
          nonprogress: 0,
        },
      ]);
      try {
        const abort = new AbortController();
        fixture.host.projectSignal = () => abort.signal;
        const before = (await fixture.backend.inspect()).bindings[0]!;
        const body = fixture.observation(before);
        const context = fixture.host.session.context!;
        let approved = false;
        fixture.approve(async () => {
          approved = true;
        });
        fixture.host.session.context = async (...args) => {
          const result = await context(...args);
          if (approved) abort.abort();
          return result;
        };
        await expect(
          fixture.control("resume", before.id, body),
        ).rejects.toThrow("Native operation aborted");
        await fixture.backend.fenceProject(observerScope.coordinatorLocation);
        expect((await fixture.backend.inspect()).bindings).toEqual([before]);
        const durable = fixture.root() as { bindings: WorkerBinding[] };
        expect(durable.bindings).toEqual([before]);
      } finally {
        await fixture.backend.dispose();
      }
    }
    {
      const dataDir = await mkdtemp(resolve(".opencode/backseat/setup-fence-"));
      const sessions = new Map<string, string>();
      const failed = await registeredCoordinator(
        false,
        undefined,
        dataDir,
        sessions,
        { failHook: "experimental.idle" },
      );
      let replacement:
        Awaited<ReturnType<typeof registeredCoordinator>> | undefined;
      try {
        expect(String(failed.setupError)).toContain("Injected setup failure");
        replacement = await registeredCoordinator(
          false,
          undefined,
          dataDir,
          sessions,
        );
        expect(replacement.setupError).toBeUndefined();
        expect(replacement.catalog.has(coordinatorAgent.id)).toBe(true);
      } finally {
        await failed.close();
        await replacement?.close();
      }
      try {
        expect(await child(dataDir, "after-failed-setup")).toBe("owned");
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
    {
      const dataDir = await mkdtemp(resolve(".opencode/backseat/ask-fence-"));
      let entered!: () => void;
      const ready = new Promise<void>((done) => {
        entered = done;
      });
      const pendingAsk = new Promise<void>(() => {});
      const project = await registeredCoordinator(
        false,
        undefined,
        dataDir,
        new Map(),
        {
          ask: async () => {
            entered();
            await pendingAsk;
          },
        },
      );
      const attachment = project.invoke("backseat_start_supervision").then(
        () => "approved",
        () => "cancelled",
      );
      await ready;
      try {
        await project.close();
        expect(await attachment).toBe("cancelled");
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
    {
      const shared = await mkdtemp(resolve(".opencode/backseat/project-core-"));
      const sessions = new Map<string, string>();
      const faults: { catalog?: () => Promise<void> } = {};
      const first = await registeredCoordinator(
        false,
        undefined,
        shared,
        sessions,
        faults,
      );
      const second = await registeredCoordinator(
        false,
        undefined,
        shared,
        sessions,
      );
      const conflicting = await registeredCoordinator(
        false,
        undefined,
        `${shared}-conflicting`,
        sessions,
      );
      try {
        expect(conflicting.setupError).toBeUndefined();
        expect(conflicting.catalog.has(coordinatorAgent.id)).toBe(true);
        expect((await conflicting.rpc.bootstrap()).authority).toBe("held");
        expect(
          await stat(`${shared}-conflicting`).catch(() => undefined),
        ).toBeUndefined();
      } finally {
        await conflicting.close();
      }
      let firstClosed = false;
      try {
        const initial = (await first.invoke("backseat_start_supervision"))
          .output as { generation: number };
        const replacement = (await second.invoke("backseat_start_supervision"))
          .output as { generation: number };
        expect(replacement.generation).toBe(initial.generation + 1);
        expect(await second.rpc.bootstrap()).toEqual({
          dataDir: shared,
          authority: "owned",
        });
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>((done) => {
          entered = done;
        });
        const wait = new Promise<void>((done) => {
          release = done;
        });
        faults.catalog = async () => {
          entered();
          await wait;
        };
        const departedRead = first.invoke("backseat_list_tasks").then(
          () => "disclosed",
          () => "withheld",
        );
        await ready;
        const unloading = first.close();
        firstClosed = true;
        release();
        expect(await departedRead).toBe("withheld");
        await unloading;
        expect(
          (await second.invoke("backseat_list_tasks")).output,
        ).toBeDefined();
        const stored = JSON.parse(
          await readFile(`${shared}/state.json`, "utf8"),
        ).values as Record<string, { supervision?: { coordinatorID: string } }>;
        expect(
          Object.values(stored).find((value) => value.supervision)?.supervision
            ?.coordinatorID,
        ).toBe(second.coordinatorID);
      } finally {
        if (!firstClosed) await first.close();
        await second.close();
        await rm(shared, { recursive: true, force: true });
      }
    }
    const directory = await fixture();
    let finishDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    let startedDrain!: () => void;
    const draining = new Promise<void>((resolve) => {
      startedDrain = resolve;
    });
    let opens = 0;
    const create = async () => {
      const owner = authority(directory, `runtime-${++opens}`);
      if ((await owner.claim()) !== "owned")
        throw new Error("Runtime authority held");
      const storage = await openSharedStorage(directory);
      return {
        storage,
        async dispose() {
          startedDrain();
          await owner.dispose(async () => {
            await drain;
            await storage.close();
          });
        },
      };
    };
    const first = await acquireCoordinatorCore(directory, create);
    let second: typeof first | undefined;
    try {
      await first.core.storage.set("consumed", {
        followUps: 2,
        uncertain: true,
      });
      second = await acquireCoordinatorCore(directory, create).catch(
        () => undefined,
      );
      expect(
        second,
        "Another enabled project must reuse the owned runtime",
      ).toBeDefined();
      if (!second) return;
      expect(await second.core.storage.get("consumed")).toEqual({
        followUps: 2,
        uncertain: true,
      });
      const other = await fixture();
      try {
        await expect(acquireCoordinatorCore(other, create)).rejects.toThrow(
          "Conflicting coordination stores",
        );
      } finally {
        await rm(other, { recursive: true, force: true });
      }
      await first.release();
      await first.release();
      expect(await child(directory, "after-project-unload")).toBe("held");
      await second.core.storage.set("consumed", {
        followUps: 3,
        uncertain: true,
      });
      const closing = second.release();
      await draining;
      const reopening = acquireCoordinatorCore(directory, create);
      expect(opens).toBe(1);
      expect(await child(directory, "during-final-drain")).toBe("held");
      finishDrain();
      await closing;
      const reopened = await reopening;
      try {
        expect(await reopened.core.storage.get("consumed")).toEqual({
          followUps: 3,
          uncertain: true,
        });
        expect(opens).toBe(2);
      } finally {
        await reopened.release();
      }
      const failedShutdown = await runChild(`
        import {acquireCoordinatorCore} from ${JSON.stringify(adapterURL)};
        let disposals=0, replacements=0;
        const lease=await acquireCoordinatorCore(${JSON.stringify(directory)},async()=>({async dispose(){disposals++;throw new Error("Shutdown failed");}}));
        const closing=lease.release();
        const first=await closing.catch(error=>error.message);
        const repeated=lease.release();
        const second=await repeated.catch(error=>error.message);
        const attempts=[];
        for(const directory of ${JSON.stringify([directory, `${directory}/other`])}) {
          attempts.push(await acquireCoordinatorCore(directory,async()=>{replacements++;return {async dispose(){}};}).then(()=>"opened",()=>"held"));
        }
        process.stdout.write(JSON.stringify({first,second,same:closing===repeated,disposals,replacements,attempts}));
      `);
      expect(JSON.parse(failedShutdown)).toEqual({
        first: "Shutdown failed",
        second: "Shutdown failed",
        same: true,
        disposals: 1,
        replacements: 0,
        attempts: ["held", "held"],
      });
    } finally {
      finishDrain();
      await second?.release();
      await first.release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("Requires explicit stale-owner recovery", async () => {
    const released: boolean[] = [];
    for (const change of ["cancel", "role"] as const) {
      const directory = await mkdtemp(
        resolve(".opencode/backseat/recover-cancel-"),
      );
      expect(await child(directory, "terminated-project", true)).toBe("owned");
      let approved = false;
      const request = new AbortController();
      let project:
        Awaited<ReturnType<typeof registeredCoordinator>> | undefined;
      try {
        project = await registeredCoordinator(
          false,
          undefined,
          directory,
          new Map(),
          {
            ask: async () => {
              approved = true;
              if (change === "role")
                project!.catalog.get(coordinatorAgent.id)!.permissions = [
                  { action: "*", resource: "*", effect: "allow" },
                ];
            },
            get: async () => {
              if (approved && change === "cancel") request.abort();
            },
          },
        );
        await project
          .invoke("backseat_recover_runtime", {}, request.signal)
          .catch(() => undefined);
        released.push(
          JSON.parse(await readFile(`${directory}/ownership.lock`, "utf8"))
            .released,
        );
      } finally {
        await project?.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
    expect(released).toEqual([false, false]);
    {
      const directory = await mkdtemp(
        resolve(".opencode/backseat/recover-project-"),
      );
      expect(await child(directory, "terminated-project", true)).toBe("owned");
      let approvals = 0;
      const project = await registeredCoordinator(
        false,
        undefined,
        directory,
        new Map(),
        {
          ask: async () => {
            approvals++;
          },
        },
      );
      try {
        expect((await project.rpc.bootstrap()).authority).toBe("held");
        expect(
          (await project.invoke("backseat_recover_runtime")).output,
        ).toMatchObject({
          dataDir: directory,
          authority: "held",
          reason:
            "Recovery approved; start supervision and explicitly resume tasks",
        });
        expect(approvals).toBe(1);
        expect(
          await readFile(`${directory}/state.json`, "utf8").catch(
            () => undefined,
          ),
        ).toBeUndefined();
        const started = await project.invoke("backseat_start_supervision");
        expect(started.output).toEqual({
          generation: 1,
          coordinatorID: project.coordinatorID,
          status: "held",
        });
        expect(approvals).toBe(2);
        expect((await project.rpc.bootstrap()).authority).toBe("owned");
        expect(await readFile(`${directory}/state.json`, "utf8")).toContain(
          "supervision",
        );
      } finally {
        await project.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
    await mockAuthority("recovery");
    const home = await fixture();
    const approvals: string[] = [];
    const next = authority(home, "next", async (_home, owner) => {
      approvals.push(owner);
      expect(await child(home, "approval-racer")).toBe("held");
    });
    try {
      expect(await child(home, "crashed", true)).toBe("owned");
      const lock = resolve(home, "ownership.lock");
      const inode = (await stat(lock)).ino;
      expect(await next.claim()).toBe("held");
      const denied = authority(home, "denied", async () => {
        throw new Error("Denied");
      });
      await expect(denied.recover()).rejects.toThrow("Denied");
      await denied.dispose(async () => {});
      expect(await next.recover()).toBe("held");
      expect(approvals).toEqual(["crashed"]);
      expect(await next.claim()).toBe("owned");
      expect((await stat(lock)).ino).toBe(inode);
      await expect(authority(home, "live-racer").recover()).rejects.toThrow(
        "Recovery is not eligible",
      );
      await next.dispose(async () => {});

      // Same PID with an unmatched start time proves the old process ended;
      // a different boot/namespace never proves local termination.
      const released = JSON.parse(await readFile(lock, "utf8"));
      for (const identity of [
        { ...released.identity, boot: "00000000-0000-0000-0000-000000000000" },
        { ...released.identity, namespace: "0" },
      ]) {
        await writeFile(
          lock,
          JSON.stringify({ ...released, released: false, identity }),
        );
        const uncertain = authority(home, "uncertain");
        expect(await uncertain.claim()).toBe("held");
        await expect(uncertain.recover()).rejects.toThrow(
          "Recovery is not eligible",
        );
        await uncertain.dispose(async () => {});
      }
      await writeFile(
        lock,
        JSON.stringify({
          ...released,
          released: false,
          identity: { ...released.identity, start: "0" },
        }),
      );
      const reused = authority(home, "pid-reused");
      expect(await reused.claim()).toBe("held");
      expect(await reused.recover()).toBe("held");
      expect(await reused.claim()).toBe("owned");
      await reused.dispose(async () => {});

      expect(await child(home, "second-crash", true)).toBe("owned");
      const racer = authority(home, "recovery-racer");
      const delayed = authority(home, "delayed", async () => {
        expect(await racer.recover()).toBe("held");
        expect(await racer.claim()).toBe("owned");
      });
      await expect(delayed.recover()).rejects.toThrow(
        "Recovery is not eligible",
      );
      expect(await delayed.claim()).toBe("held");
      await racer.dispose(async () => {});
      await delayed.dispose(async () => {});

      for (const change of ["owner", "identity"]) {
        expect(await child(home, `${change}-crash`, true)).toBe("owned");
        const changed = authority(home, "changed", async () => {
          const record = JSON.parse(await readFile(lock, "utf8"));
          if (change === "owner") record.owner = "unapproved-successor";
          else record.identity.start = "0";
          await writeFile(lock, JSON.stringify(record));
        });
        await expect(changed.recover()).rejects.toThrow(
          "Recovery is not eligible",
        );
        expect(await changed.claim()).toBe("held");
        await changed.dispose(async () => {});
        const fresh = authority(home, "fresh");
        expect(await fresh.recover()).toBe("held");
        expect(await fresh.claim()).toBe("owned");
        await fresh.dispose(async () => {});
      }
    } finally {
      await next.dispose(async () => {});
      await rm(home, { recursive: true, force: true });
    }
  });
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Explicit adoption", () => {
  it("Adopts the selected existing worker", async () => {
    const saved: WorkerBinding[] = [];
    const approved: string[] = [];
    const host: AdoptionHost = {
      async read(workerID) {
        return {
          id: workerID,
          agent: goal.agent,
          location: { directory: goal.location },
          history: "Unrelated previous task",
        };
      },
      async bindingFor() {
        return undefined;
      },
      async approve(_goal, workerID) {
        approved.push(workerID);
      },
      async save(binding) {
        saved.push(binding);
      },
    };
    const binding = await adoptWorker(goal, "existing-api", host);
    expect(binding?.workerID).toBe("existing-api");
    expect(approved).toEqual(["existing-api"]);
    expect(saved[0]?.goal).toBe(goal.goal);
    expect(binding?.status).toBe("held");
    expect(JSON.stringify(binding)).not.toContain("previous task");
  });

  it("Rejects competing ownership", async () => {
    const owner: WorkerBinding = {
      ...goal,
      id: "other-task",
      workerID: "existing-api",
      revision: 1,
      epoch: 1,
      status: "held",
      followups: 2,
      nonprogress: 1,
    };
    for (const concurrent of [false, true]) {
      const saved: WorkerBinding[] = [];
      let reads = 0;
      const host: AdoptionHost = {
        async read(workerID) {
          return {
            id: workerID,
            agent: goal.agent,
            location: { directory: goal.location },
          };
        },
        async bindingFor() {
          return concurrent && reads++ === 0 ? undefined : owner;
        },
        async approve() {},
        async save(binding) {
          saved.push(binding);
        },
      };
      await expect(adoptWorker(goal, "existing-api", host)).rejects.toThrow(
        "Worker already owned",
      );
      expect(saved).toHaveLength(0);
    }
  });
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Conversational manual assignment", () => {
  it("Deletes the approved native subtree and preserves task history", async () => {
    for (const mode of [
      "held",
      "active",
      "complete",
      "new-descendant",
    ] as const) {
      const b: WorkerBinding = {
        ...goal,
        workerID: "delete-root",
        revision: 1,
        epoch: 1,
        status: mode === "complete" ? "complete" : "held",
        followups: 2,
        nonprogress: 1,
      };
      const ref = {
        messageID: "verified-message",
        callID: "verified-call",
        state: "completed" as const,
        inputFingerprint: fingerprint("input"),
        resultFingerprint: fingerprint("result"),
        inspectedContentFingerprint: fingerprint("content"),
      };
      const completion: import("../src/state.ts").CompletionRecord = {
        taskID: b.id,
        workerID: b.workerID,
        revision: b.revision,
        epoch: b.epoch,
        generation: 1,
        support: b.criteria.map((criterion) => ({
          criterion,
          evidenceID: ref.callID,
        })),
        evidence: {
          taskID: b.id,
          workerID: b.workerID,
          turn: 1,
          fingerprint: fingerprint("evidence"),
          native: [ref],
        },
        validation: {
          receiptID: "verified-receipt",
          status: "accept",
          rationale: "Verified criterion evidence",
          identity: {
            taskID: b.id,
            workerID: b.workerID,
            location: b.location,
            revision: b.revision,
            epoch: b.epoch,
            generation: 1,
            turn: 1,
            nativeBoundary: ref.messageID,
            snapshotIncarnation: "incarnation",
            snapshotSequence: 1,
            snapshotInvalidationVersion: 0,
            evidenceFingerprint: fingerprint("evidence"),
            sharedVersions: [],
            suggestionFingerprint: fingerprint("suggestion"),
          },
          criteria: b.criteria.map((criterion) => ({
            criterion,
            status: "accept",
            rationale: "Verified criterion evidence",
            evidence: [ref],
          })),
        },
      };
      const child = {
        ...b,
        id: `${b.id}-child`,
        workerID: "delete-child",
        status: "held" as const,
      };
      const f = await backendFixture(
        mode === "new-descendant" ? [b, child] : [b],
        0,
        mode !== "active",
        mode === "active",
        mode === "complete" ? [completion] : [],
      );
      if (mode === "active") {
        const current = (await f.backend.inspect()).bindings[0]!;
        await f.control("resume", b.id, f.observation(current));
        expect((await f.backend.inspect()).bindings[0]?.status).toBe("active");
      }
      const baseline = parseCoordinatorState(f.root());
      const approvalCount = f.asks.length;
      let childVisible = mode !== "new-descendant";
      f.approve(async () => {
        childVisible = true;
      });
      const get = f.host.session.get;
      f.host.session.get = async (input) => ({
        ...(await get(input)),
        ...(input.sessionID === "delete-child"
          ? { parentID: "delete-root" }
          : {}),
      });
      f.host.session.list = async (input) => ({
        data:
          input?.parentID === "delete-root" && childVisible
            ? [await f.host.session.get({ sessionID: "delete-child" })]
            : [],
        cursor: {},
      });
      let removes = 0;
      f.host.session.remove = async ({ sessionID }) => {
        expect(sessionID).toBe("delete-root");
        expect(f.values.get("coordinator:deletions")).toMatchObject({
          version: 1,
          records: [{ sessionID: "delete-root", status: "pending" }],
        });
        expect(
          (f.root() as { bindings: WorkerBinding[] }).bindings[0],
        ).toMatchObject({
          status: mode === "complete" ? "complete" : "held",
          epoch: baseline.bindings[0]!.epoch + (mode === "complete" ? 0 : 1),
        });
        if (mode === "new-descendant")
          expect(parseCoordinatorState(f.root()).bindings[1]).toMatchObject({
            status: "held",
            epoch: child.epoch + 1,
          });
        removes++;
      };
      try {
        const before = parseCoordinatorState(f.root());
        expect(
          await f.backend.deleteSession("delete-root", {
            sessionID: "coordinator",
            agent: coordinatorAgent.id,
            messageID: "message",
            id: "delete-call",
          }),
        ).toEqual({
          sessionID: "delete-root",
          status: "deleted",
          affectedTasks: mode === "new-descendant" ? [b.id, child.id] : [b.id],
        });
        expect(removes).toBe(1);
        expect(f.asks.slice(approvalCount)).toEqual([
          "backseat.delete_session",
        ]);
        expect(
          await f.backend.inspectDeletions(b.id, {
            sessionID: "coordinator",
            agent: coordinatorAgent.id,
            messageID: "message",
            id: "inspect-call",
          }),
        ).toMatchObject([
          {
            sessionID: "delete-root",
            status: "deleted",
            observations: [
              { sessionID: "delete-root", status: "absent" },
              { sessionID: "delete-child", status: "absent" },
            ],
          },
        ]);
        expect(parseCoordinatorState(f.root()).intents).toEqual(before.intents);
        expect(parseCoordinatorState(f.root()).completions).toEqual(
          before.completions,
        );
        expect(parseCoordinatorState(f.root()).bindings[0]).toMatchObject({
          followups: 2,
          nonprogress: 1,
          epoch: baseline.bindings[0]!.epoch + (mode === "complete" ? 0 : 1),
        });
      } finally {
        await f.backend.dispose();
      }
    }
  });

  it("Rejects unsafe deletion and retains uncertain outcomes", async () => {
    for (const mode of [
      "self",
      "ancestor",
      "cycle",
      "denied",
      "uncertain",
      "abort-before-remove",
      "publication",
      "partial",
      "wrong-parent",
    ] as const) {
      const f = await backendFixture(
        mode === "uncertain"
          ? [
              {
                ...goal,
                workerID: "delete-root",
                revision: 1,
                epoch: 1,
                status: "held",
                followups: 0,
                nonprogress: 0,
              },
            ]
          : [],
        0,
        false,
        false,
      );
      const get = f.host.session.get;
      const cancellation = new AbortController();
      const set = f.host.storage.set;
      const journalWrites = spyOn(f.host.storage, "set").mockImplementation(
        async (key, value) => {
          const journal = value as { records?: { status: string }[] };
          if (
            key === "coordinator:deletions" &&
            mode === "publication" &&
            journal.records?.[0]?.status !== "pending"
          )
            throw new Error("Journal publication failed");
          await set(key, value);
          if (
            key === "coordinator:deletions" &&
            mode === "abort-before-remove" &&
            journal.records?.[0]?.status === "pending"
          )
            cancellation.abort(new Error("Deletion cancelled"));
        },
      );
      f.host.session.get = async (input) => ({
        ...(await get(input)),
        ...(input.sessionID === "coordinator" &&
        (mode === "ancestor" || mode === "cycle")
          ? { parentID: mode === "cycle" ? "coordinator" : "delete-root" }
          : {}),
      });
      f.host.session.list = async () => ({
        data:
          mode === "wrong-parent"
            ? [{ ...(await get({ sessionID: "child" })), parentID: "other" }]
            : [],
        cursor: mode === "partial" ? { next: "next" } : {},
      });
      let removes = 0;
      f.host.session.remove = async () => {
        removes++;
        throw new Error("Native acknowledgement lost");
      };
      if (mode === "denied")
        f.approve(async () => {
          throw new Error("Denied");
        });
      const identity = {
        sessionID: "coordinator",
        agent: coordinatorAgent.id,
        messageID: "message",
        id: "delete-call",
        signal: cancellation.signal,
      };
      try {
        if (mode === "uncertain") {
          expect(
            await f.backend.deleteSession("delete-root", identity),
          ).toMatchObject({ status: "uncertain" });
          await expect(
            f.backend.deleteSession("delete-root", identity),
          ).rejects.toThrow("Unresolved or retained deletion");
          expect(f.values.get("coordinator:deletions")).toMatchObject({
            records: [{ status: "uncertain" }],
          });
          expect(removes).toBe(1);
          f.host.session.list = async (input) => ({
            data:
              input?.parentID === "new-parent"
                ? [
                    {
                      ...(await get({ sessionID: "delete-root" })),
                      parentID: "new-parent",
                    },
                  ]
                : [],
            cursor: {},
          });
          await expect(
            f.backend.deleteSession("new-parent", identity),
          ).rejects.toThrow("overlap");
          expect(removes).toBe(1);
          await f.backend.dispose();
          const reopened = await createNativeBackend(
            f.host,
            new CoordinatorOwnership("/projects/home", "deletion-reload", {
              inspect: async () => ({ safe: true }),
              acquire: async () => true,
              release: async () => {},
              approveRecovery: async () => {},
              recover: async () => {},
            }),
            "/projects/home",
          );
          try {
            await expect(
              reopened.deleteSession("delete-root", identity),
            ).rejects.toThrow("retained deletion");
            await expect(
              reopened.sendSession(
                {
                  sessionID: "delete-root",
                  location: goal.location,
                  agent: goal.agent,
                  text: "Do not repeat deleted work",
                  scope: goal.scope,
                },
                identity,
              ),
            ).rejects.toThrow("retained deletion");
            expect(f.effects).not.toContain("prompt");
            for (const operation of ["dispatch", "resume"] as const)
              await expect(
                reopened.nativeControl(
                  operation,
                  goal.id,
                  operation === "dispatch"
                    ? { text: "Work", scope: goal.scope }
                    : {},
                  identity,
                ),
              ).rejects.toThrow("retained deletion outcome");
            expect(
              await reopened.inspectDeletions(goal.id, identity),
            ).toMatchObject([
              {
                status: "uncertain",
                observations: [{ sessionID: "delete-root", status: "absent" }],
              },
            ]);
            expect(removes).toBe(1);
          } finally {
            await reopened.dispose();
          }
        } else if (mode === "publication") {
          expect(
            await f.backend.deleteSession("delete-root", identity),
          ).toMatchObject({ status: "uncertain" });
          expect(await f.backend.inspect()).toMatchObject({
            authority: "held",
          });
          expect(removes).toBe(1);
        } else {
          await expect(
            f.backend.deleteSession(
              mode === "self" ? "coordinator" : "delete-root",
              identity,
            ),
          ).rejects.toThrow(
            mode === "self" || mode === "ancestor"
              ? "invoking coordinator"
              : mode === "cycle"
                ? "ancestry"
                : mode === "denied"
                  ? "Denied"
                  : mode === "abort-before-remove"
                    ? "Deletion cancelled"
                    : "Incomplete",
          );
          expect(removes).toBe(0);
          if (mode === "abort-before-remove")
            expect(f.values.get("coordinator:deletions")).toMatchObject({
              records: [],
            });
        }
      } finally {
        journalWrites.mockRestore();
        await f.backend.dispose();
      }
    }
  });
  it("Adopts a selected child without widening ownership", async () => {
    for (const operation of ["adopt", "takeover"] as const) {
      const selected: WorkerBinding = {
        ...goal,
        workerID: "worker-api",
        revision: 1,
        epoch: 1,
        status: "held",
        followups: 0,
        nonprogress: 0,
      };
      const f = await backendFixture(
        operation === "adopt" ? [] : [selected],
        0,
        false,
        false,
      );
      const get = f.host.session.get;
      f.host.session.get = async (input) => ({
        ...(await get(input)),
        ...(input.sessionID === selected.workerID
          ? { parentID: "native-parent" }
          : {}),
      });
      try {
        await f.backend.nativeControl(
          operation,
          selected.id,
          operation === "adopt" ? { goal, workerID: selected.workerID } : {},
          {
            sessionID: "coordinator",
            agent: coordinatorAgent.id,
            messageID: "message",
            id: "ownership-call",
          },
        );
        expect(f.effects).toEqual([]);
        const current = (await f.backend.inspect()).bindings;
        expect(current).toHaveLength(1);
        expect(current[0]).toMatchObject({
          workerID: selected.workerID,
          status: operation === "adopt" ? "held" : "manual",
        });
        expect(f.asks).toEqual([`backseat.${operation}`]);
      } finally {
        await f.backend.dispose();
      }
    }
    const root = await backendFixture([binding], 0, false, false);
    const agents = root.host.agent.list;
    root.host.agent.list = async (...input) => {
      const result = await agents(...input);
      return {
        ...result,
        data: result.data.filter((agent) => agent.id === coordinatorAgent.id),
      };
    };
    try {
      await root.backend.nativeControl("takeover", binding.id, {}, identity);
      expect((await root.backend.inspect()).bindings[0]?.status).toBe("manual");
      expect(root.effects).toEqual([]);
    } finally {
      await root.backend.dispose();
    }
  });
  it("Rejects changed hierarchical targets", async () => {
    for (const operation of ["adopt", "takeover"] as const) {
      const f = await backendFixture(
        operation === "adopt" ? [] : [binding],
        0,
        false,
        false,
      );
      let parentID = "selected-parent";
      const get = f.host.session.get;
      f.host.session.get = async (input) => ({
        ...(await get(input)),
        ...(input.sessionID === binding.workerID ? { parentID } : {}),
      });
      f.approve(async () => {
        parentID = "changed-parent";
      });
      try {
        await expect(
          f.backend.nativeControl(
            operation,
            binding.id,
            operation === "adopt" ? { goal, workerID: binding.workerID } : {},
            identity,
          ),
        ).rejects.toThrow("changed");
        expect(f.asks).toHaveLength(1);
        expect((await f.backend.inspect()).bindings).toEqual(
          operation === "adopt" ? [] : [binding],
        );
        expect(f.effects).toEqual([]);
      } finally {
        await f.backend.dispose();
      }
    }
  });
  const identity = {
    sessionID: "coordinator",
    agent: coordinatorAgent.id,
    messageID: "message",
    id: "native-call",
  };
  const binding: WorkerBinding = {
    ...goal,
    workerID: "worker-api",
    revision: 1,
    epoch: 1,
    status: "held",
    followups: 0,
    nonprogress: 0,
  };

  it("Takes over a selected session without inventing work", async () => {
    const unbound = await backendFixture([], 0, false, false);
    try {
      await unbound.backend.nativeControl(
        "adopt",
        binding.id,
        { goal, workerID: binding.workerID },
        identity,
      );
      expect((await unbound.backend.inspect()).bindings[0]).toMatchObject({
        workerID: binding.workerID,
        location: goal.location,
        status: "held",
      });
      expect(unbound.effects).toEqual([]);
      expect(unbound.asks).toEqual(["backseat.adopt"]);
      expect((await unbound.backend.inspect()).observer).toBeUndefined();
    } finally {
      await unbound.backend.dispose();
    }
    const f = await backendFixture(
      [{ ...binding, status: "active" }],
      0,
      false,
      false,
    );
    try {
      const before = (await f.backend.inspect()).bindings[0]!;
      await f.backend.nativeControl("takeover", binding.id, {}, identity);
      expect((await f.backend.inspect()).bindings[0]).toMatchObject({
        status: "manual",
        epoch: before.epoch + 1,
      });
      expect(f.effects).toEqual([]);
      expect(f.asks).toEqual(["backseat.takeover"]);
    } finally {
      await f.backend.dispose();
    }
  });

  it("Sends repeated assignments without automation prerequisites", async () => {
    const consumed = {
      ...binding,
      scope: [...binding.scope, "approved-tests"],
      followups: 2,
      nonprogress: 1,
    };
    const f = await backendFixture([consumed], 0, false, false);
    const catalog = f.host.agent.list;
    f.host.agent.list = async (...input) => {
      const result = await catalog(...input);
      return {
        ...result,
        data: result.data.map((agent) => ({
          ...agent,
          permissions: [...agent.permissions, ...inheritedPolicy],
        })),
      };
    };
    const prompts: string[] = [];
    const approvals: string[][] = [];
    const approve = f.host.permission.assert;
    const approval = spyOn(f.host.permission, "assert").mockImplementation(
      async (input) => {
        approvals.push([...input.resources]);
        return approve(input);
      },
    );
    f.host.session.prompt = async (input) => {
      const state = parseCoordinatorState(f.root());
      expect(state.intents.at(-1)?.intent).toMatchObject({
        id: input.id,
        status: "reserved",
        text: input.text,
      });
      prompts.push(input.text!);
      return { id: input.id, sessionID: input.sessionID } as Awaited<
        ReturnType<NativeBackendHost["session"]["prompt"]>
      >;
    };
    try {
      for (const text of [
        "Implement the approved task",
        "Verify the approved task",
      ])
        await f.backend.nativeControl(
          "dispatch",
          binding.id,
          { text, scope: binding.scope },
          identity,
        );
      const state = parseCoordinatorState(f.root());
      expect(prompts).toEqual([
        "Implement the approved task",
        "Verify the approved task",
      ]);
      expect(
        state.intents.map((i) => [i.kind, i.generation, i.intent.status]),
      ).toEqual([
        ["manual", 0, "admitted"],
        ["manual", 0, "admitted"],
      ]);
      expect(new Set(state.intents.map((i) => i.intent.id)).size).toBe(2);
      expect(state.bindings[0]).toEqual(consumed);
      expect(f.asks).toEqual(["backseat.dispatch", "backseat.dispatch"]);
      for (const [index, resources] of approvals.entries()) {
        const outer = JSON.parse(resources[0]!);
        const payload = JSON.parse(outer[3]);
        expect(payload).toEqual([
          outer[0],
          consumed,
          prompts[index],
          binding.scope,
          state.intents[index]!.intent.id,
        ]);
      }
      expect(state.observer).toBeUndefined();
      await f.backend.startSupervision(nativeIdentity());
      const get = f.host.session.get;
      f.host.session.get = (input) =>
        get({
          ...input,
          sessionID:
            input.sessionID === "new-coordinator"
              ? "coordinator"
              : input.sessionID,
        }).then((session) => ({ ...session, id: input.sessionID }));
      await f.backend.nativeControl(
        "dispatch",
        binding.id,
        { text: "Review the approved task", scope: binding.scope },
        {
          ...identity,
          sessionID: "new-coordinator",
        },
      );
      expect(prompts.at(-1)).toBe("Review the approved task");
      expect((await f.backend.inspect()).bindings[0]?.status).toBe("held");
    } finally {
      approval.mockRestore();
      await f.backend.dispose();
    }
    const unbound = await backendFixture([], 0, false, false);
    try {
      const sends: string[] = [];
      unbound.host.session.prompt = async (input) => {
        const state = parseCoordinatorState(unbound.root());
        expect(state.sessionDeliveries?.at(-1)).toMatchObject({
          id: input.id,
          sessionID: input.sessionID,
          status: "reserved",
        });
        sends.push(input.text!);
        return { id: input.id, sessionID: input.sessionID } as Awaited<
          ReturnType<NativeBackendHost["session"]["prompt"]>
        >;
      };
      for (const [index, assignment] of [
        "Inspect current work",
        "Report findings",
      ].entries()) {
        const result = await unbound.backend.sendSession(
          {
            sessionID: "worker-api",
            location: goal.location,
            agent: goal.agent,
            text: assignment,
          },
          { ...identity, id: `unbound-${index}` },
        );
        expect(result).toMatchObject({
          sessionID: "worker-api",
          status: "admitted",
        });
        expect(result.sendID).toStartWith("msg_");
      }
      expect(sends).toEqual(["Inspect current work", "Report findings"]);
      const state = parseCoordinatorState(unbound.root());
      expect(state.bindings).toEqual([]);
      expect(state.intents).toEqual([]);
      expect(state.sessionDeliveries?.map((entry) => entry.status)).toEqual([
        "admitted",
        "admitted",
      ]);
      expect(unbound.asks).toEqual([
        "backseat.send_session",
        "backseat.send_session",
      ]);
      const nested = [
        {
          sessionID: "worker-one",
          location: goal.location,
          agent: goal.agent,
          text: "Inspect",
        },
        {
          sessionID: "worker-two",
          location: goal.location,
          agent: goal.agent,
          text: "Inspect",
        },
        {
          sessionID: "worker-two",
          location: goal.location,
          agent: goal.agent,
          text: "Report",
        },
      ];
      const nestedIDs = [];
      for (const request of nested)
        nestedIDs.push(
          (await unbound.backend.sendSession(request, identity)).sendID,
        );
      expect(new Set(nestedIDs).size).toBe(3);
      expect(
        (await unbound.backend.sendSession(nested[2]!, identity)).sendID,
      ).toBe(nestedIDs[2]!);
      expect(sends).toHaveLength(5);
      unbound.host.nativeSend = async (input, sendID) => {
        const reserved = parseCoordinatorState(
          unbound.root(),
        ).sessionDeliveries?.at(-1);
        expect(reserved?.id).toBe(sendID);
        expect(reserved?.status).toBe("reserved");
        expect(reserved?.operation).toBe(input.kind);
        return { id: sendID, sessionID: input.sessionID };
      };
      for (const kind of [
        "synthetic",
        "shell",
        "compact",
        "command",
        "skill",
      ] as const) {
        const sent = await unbound.backend.sendSession(
          {
            sessionID: "worker-api",
            location: goal.location,
            agent: goal.agent,
            text: "Selected input",
            kind,
            options:
              kind === "command"
                ? { name: "review" }
                : kind === "skill"
                  ? { skillID: "selected" }
                  : {},
          },
          { ...identity, id: kind },
        );
        expect(sent.status).toBe("admitted");
        expect(unbound.asks.at(-1)).toBe(`backseat.${kind}_session`);
      }
      const nativeCalls: unknown[] = [];
      const call = (name: string) => async (payload: unknown) => {
        nativeCalls.push([name, payload]);
      };
      const client = {
        session: {
          prompt: call("prompt"),
          synthetic: call("synthetic"),
          shell: call("shell"),
          compact: call("compact"),
          command: call("command"),
        },
        experimental: { session: { skill: call("skill") } },
      } as unknown as OpenCodeClient;
      const file = {
        uri: "file:///projects/api/README.md",
        source: { type: "uri", uri: "file:///projects/api/README.md" },
        name: "README",
        mention: { start: 0, end: 6, text: "README" },
      };
      for (const [kind, options, expected] of [
        [
          "prompt",
          {
            files: [file],
            agents: [{ name: "reviewer" }],
            skills: [{ id: "review" }],
            metadata: { selected: true },
            delivery: "queue",
            resume: false,
          },
          {
            id: "msg_selected",
            text: "Selected input",
            files: [file],
            agents: [{ name: "reviewer" }],
            skills: [{ id: "review" }],
            metadata: { selected: true },
            delivery: "queue",
            resume: false,
          },
        ],
        [
          "synthetic",
          { description: "Selected context", resume: false },
          {
            id: "msg_selected",
            text: "Selected input",
            description: "Selected context",
            resume: false,
          },
        ],
        ["shell", {}, { id: "msg_selected", command: "Selected input" }],
        [
          "compact",
          { delivery: "queue" },
          { id: "msg_selected", delivery: "queue" },
        ],
        [
          "command",
          { name: "review", files: [file] },
          { name: "review", text: "Selected input", files: [file] },
        ],
        [
          "skill",
          { skillID: "review", resume: false },
          { id: "review", resume: false },
        ],
      ] as const) {
        await prepareNativeSend(
          { sessionID: "worker-api", text: "Selected input", kind, options },
          "msg_selected",
        )(client, new AbortController().signal);
        expect(nativeCalls.at(-1)).toEqual([
          kind,
          { sessionID: "worker-api", ...expected },
        ]);
      }
    } finally {
      await unbound.backend.dispose();
    }
  });

  it("Rejects changed or unapproved manual targets", async () => {
    for (const mode of [
      "outside",
      "missing",
      "empty",
      "unbound",
      "valid",
    ] as const) {
      const f = await backendFixture(
        mode === "unbound" ? [] : [binding],
        0,
        false,
        false,
      );
      const before = parseCoordinatorState(f.root());
      try {
        const request = {
          sessionID: binding.workerID,
          location: binding.location,
          agent: binding.agent,
          text: "Use the approved scope",
          ...(mode === "missing"
            ? {}
            : {
                scope:
                  mode === "outside"
                    ? ["outside-approved-scope"]
                    : mode === "empty"
                      ? []
                      : binding.scope,
              }),
        };
        if (mode === "valid") {
          expect((await f.backend.sendSession(request, identity)).status).toBe(
            "admitted",
          );
          const after = parseCoordinatorState(f.root());
          expect(after.bindings[0]).toMatchObject({
            status: "manual",
            epoch: before.bindings[0]!.epoch + 1,
          });
          expect(after.sessionDeliveries).toHaveLength(1);
          expect(f.asks).toEqual(["backseat.send_session"]);
          expect(f.effects).toEqual(["prompt"]);
        } else {
          await expect(
            f.backend.sendSession(request, identity),
          ).rejects.toThrow();
          expect(f.asks).toEqual([]);
          expect(f.effects).toEqual([]);
          expect(parseCoordinatorState(f.root())).toEqual(before);
        }
      } finally {
        await f.backend.dispose();
      }
    }
    for (const mode of [
      "denied",
      "moved",
      "scope",
      "empty-scope",
      "missing-scope",
      "identity",
    ] as const) {
      const f = await backendFixture([binding], 0, false, false);
      f.approve(async () => {
        if (mode === "denied") throw new Error("Native dispatch denied");
        if (mode === "moved") f.move();
        if (mode === "identity") {
          const get = f.host.session.get;
          f.host.session.get = async (input) => ({
            ...(await get(input)),
            agent:
              input.sessionID === identity.sessionID
                ? "engineer"
                : binding.agent,
          });
        }
      });
      try {
        await expect(
          f.backend.nativeControl(
            "dispatch",
            binding.id,
            {
              text: "Approved assignment",
              ...(mode === "missing-scope"
                ? {}
                : {
                    scope:
                      mode === "scope"
                        ? ["unapproved-project"]
                        : mode === "empty-scope"
                          ? []
                          : binding.scope,
                  }),
            },
            identity,
          ),
        ).rejects.toThrow();
        expect(f.effects).toEqual([]);
        expect(parseCoordinatorState(f.root()).intents).toEqual([]);
      } finally {
        await f.backend.dispose();
      }
    }
    for (const mode of ["denied", "moved", "identity", "cancelled"] as const) {
      const f = await backendFixture([], 0, false, false);
      const request = new AbortController();
      f.approve(async () => {
        if (mode === "cancelled") request.abort();
        if (mode === "denied") throw new Error("Native dispatch denied");
        if (mode === "moved") f.move();
        if (mode === "identity") {
          const get = f.host.session.get;
          f.host.session.get = async (input) => ({
            ...(await get(input)),
            agent:
              input.sessionID === identity.sessionID ? "engineer" : goal.agent,
          });
        }
      });
      try {
        await expect(
          f.backend.sendSession(
            {
              sessionID: "worker-api",
              location: goal.location,
              agent: goal.agent,
              text: "Approved assignment",
            },
            { ...identity, signal: request.signal },
          ),
        ).rejects.toThrow();
        expect(f.effects).toEqual([]);
        expect(
          parseCoordinatorState(f.root()).sessionDeliveries,
        ).toBeUndefined();
      } finally {
        await f.backend.dispose();
      }
    }
  });

  it("Retains an uncertain manual send without resending", async () => {
    for (const mismatch of ["id", "sessionID"] as const) {
      const f = await backendFixture([], 0, false, false);
      let sends = 0;
      f.host.session.prompt = async (input) => {
        sends++;
        return {
          id: mismatch === "id" ? "wrong" : input.id,
          sessionID: mismatch === "sessionID" ? "wrong" : input.sessionID,
        } as Awaited<ReturnType<NativeBackendHost["session"]["prompt"]>>;
      };
      const input = {
        sessionID: "worker-api",
        location: goal.location,
        agent: goal.agent,
        text: "Selected assignment",
      };
      const first = await f.backend.sendSession(input, identity);
      expect(first.status).toBe("uncertain");
      expect(await f.backend.sendSession(input, identity)).toEqual(first);
      expect(sends).toBe(1);
      expect(
        parseCoordinatorState(f.root()).sessionDeliveries![0]!.status,
      ).toBe("ambiguous");
      await f.backend.dispose();
    }
    for (const failure of [
      "transport",
      "publication",
      "ack-id",
      "ack-session",
    ] as const) {
      const f = await backendFixture([binding], 0, false, false);
      let sends = 0;
      f.host.session.prompt = async (input) => {
        sends++;
        if (failure === "transport")
          throw new Error("Admission acknowledgement lost");
        if (failure === "publication") f.failWrite();
        return {
          id: failure === "ack-id" ? "different-delivery" : input.id,
          sessionID:
            failure === "ack-session" ? "different-worker" : input.sessionID,
        } as Awaited<ReturnType<NativeBackendHost["session"]["prompt"]>>;
      };
      try {
        await expect(
          f.backend.nativeControl(
            "dispatch",
            binding.id,
            { text: "Approved assignment", scope: binding.scope },
            identity,
          ),
        ).rejects.toThrow(
          failure === "transport"
            ? "Admission acknowledgement lost"
            : failure === "publication"
              ? "Storage failed"
              : "Mismatched admission acknowledgement",
        );
        const persisted = parseCoordinatorState(f.root());
        expect(persisted.intents[0]).toMatchObject({
          kind: "manual",
          intent: {
            status: failure === "publication" ? "reserved" : "ambiguous",
          },
        });
        await f.backend.dispose();
        f.failWrite(false);
        const restored = await createNativeBackend(
          f.host,
          new CoordinatorOwnership("/projects/home", "restored", {
            inspect: async () => ({ safe: true }),
            acquire: async () => true,
            release: async () => {},
            approveRecovery: async () => {},
            recover: async () => {},
          }),
          "/projects/home",
        );
        try {
          await expect(
            restored.nativeControl(
              "dispatch",
              binding.id,
              { text: "Another assignment", scope: binding.scope },
              identity,
            ),
          ).rejects.toThrow("Unresolved");
          expect(sends).toBe(1);
          expect(parseCoordinatorState(f.root()).intents).toEqual(
            persisted.intents.map((stored) => ({
              ...stored,
              intent: { ...stored.intent, status: "ambiguous" as const },
            })),
          );
          f.host.readDelivery = async (_binding, intent) => {
            expect(intent.id).toBe(persisted.intents[0]!.intent.id);
            return "admitted";
          };
          f.host.session.prompt = async (input) => {
            sends++;
            expect(input.id).not.toBe(persisted.intents[0]!.intent.id);
            return { id: input.id, sessionID: input.sessionID } as Awaited<
              ReturnType<NativeBackendHost["session"]["prompt"]>
            >;
          };
          await restored.nativeControl(
            "dispatch",
            binding.id,
            { text: "Another assignment", scope: binding.scope },
            identity,
          );
          expect(sends).toBe(2);
          expect(
            parseCoordinatorState(f.root()).intents[0]?.intent,
          ).toMatchObject({
            id: persisted.intents[0]!.intent.id,
            status: "admitted",
          });
        } finally {
          await restored.dispose();
        }
      } finally {
        await f.backend.dispose();
      }
    }
    const f = await backendFixture([], 0, false, false);
    let sends = 0;
    f.host.session.prompt = async () => {
      sends++;
      throw new Error("Admission acknowledgement lost");
    };
    const input = {
      sessionID: "worker-api",
      location: goal.location,
      agent: goal.agent,
      text: "Approved assignment",
    };
    try {
      const first = await f.backend.sendSession(input, identity);
      expect(first.status).toBe("uncertain");
      expect(await f.backend.sendSession(input, identity)).toEqual(first);
      f.host.readSessionDelivery = async () => {
        throw new Error("Private native transport payload");
      };
      await expect(
        f.backend.sendSession(input, { ...identity, id: "another-call" }),
      ).rejects.toThrow("Unresolved");
      expect(sends).toBe(1);
      const persisted = parseCoordinatorState(f.root());
      expect(persisted.bindings).toEqual([]);
      expect(persisted.sessionDeliveries).toMatchObject([
        {
          id: first.sendID,
          status: "ambiguous",
        },
      ]);
      await f.backend.dispose();
      const restored = await createNativeBackend(
        f.host,
        new CoordinatorOwnership("/projects/home", "restored", {
          inspect: async () => ({ safe: true }),
          acquire: async () => true,
          release: async () => {},
          approveRecovery: async () => {},
          recover: async () => {},
        }),
        "/projects/home",
      );
      try {
        await expect(
          restored.sendSession(input, { ...identity, id: "another-call" }),
        ).rejects.toThrow("Unresolved");
        expect(sends).toBe(1);
        await restored.nativeControl(
          "adopt",
          binding.id,
          { goal, workerID: binding.workerID },
          identity,
        );
        await expect(
          restored.nativeControl(
            "dispatch",
            binding.id,
            { text: input.text, scope: binding.scope },
            identity,
          ),
        ).rejects.toThrow("Unresolved");
        expect(sends).toBe(1);
        f.host.readSessionDelivery = async (delivery) => {
          expect(delivery.id).toBe(first.sendID);
          return "admitted";
        };
        f.host.session.prompt = async (send) => {
          sends++;
          return { id: send.id, sessionID: send.sessionID } as Awaited<
            ReturnType<NativeBackendHost["session"]["prompt"]>
          >;
        };
        expect(
          (
            await restored.sendSession(
              { ...input, scope: binding.scope },
              { ...identity, id: "another-call" },
            )
          ).status,
        ).toBe("admitted");
        expect(sends).toBe(2);
        expect(
          parseCoordinatorState(f.root()).sessionDeliveries?.[0],
        ).toMatchObject({
          id: first.sendID,
          status: "admitted",
        });
      } finally {
        await restored.dispose();
      }
    } finally {
      await f.backend.dispose();
    }
  });
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Explicit control transitions", () => {
  const binding: WorkerBinding = {
    ...goal,
    workerID: "worker-api",
    revision: 4,
    epoch: 9,
    status: "active",
    followups: 2,
    nonprogress: 1,
  };

  it("Takeover invalidates automatic follow-ups", async () => {
    const manual = takeoverWorker(binding);
    expect(manual?.status).toBe("manual");
    expect(manual?.epoch).toBeGreaterThan(binding.epoch);
    expect(manual?.followups).toBe(binding.followups);
    expect(binding.status).toBe("active");
    const f = await backendFixture([{ ...binding, status: "held" }]);
    try {
      const before = await f.backend.inspect();
      f.approve(async () => {
        throw new Error("Native hold denied");
      });
      await expect(
        f.backend.nativeControl(
          "hold",
          binding.id,
          {},
          {
            sessionID: "coordinator",
            agent: coordinatorAgent.id,
            messageID: "message",
            id: "native-call",
          },
        ),
      ).rejects.toThrow("Native hold denied");
      expect((await f.backend.inspect()).bindings).toEqual(before.bindings);
    } finally {
      await f.backend.dispose();
    }
  });

  it("Resume requires fresh eligible state", async () => {
    for (const problem of [
      "valid",
      "pending",
      "changed",
      "denied",
      "unresolved",
      "reconciled",
      "exhausted",
      "unstarted",
      "rearm",
    ] as const) {
      const f = await backendFixture(
        [
          {
            ...binding,
            status: "held",
            ...(problem === "exhausted" ? { followups: 3 } : {}),
          },
        ],
        0,
        problem === "unresolved" || problem === "reconciled",
        false,
      );
      const identity = {
        sessionID: "coordinator",
        agent: coordinatorAgent.id,
        messageID: "resume-message",
        id: "resume-call",
      };
      let nativeReads = 0;
      if (problem === "reconciled")
        f.host.readDelivery = async (_task, intent) => {
          expect(intent.id).toBe("initial");
          return "admitted";
        };
      f.host.observeNative = async (task, _snapshots, observed) => {
        nativeReads++;
        if (problem === "rearm" && task.status === "active")
          throw new Error("Native worker became unavailable during rearm");
        return {
          turn: 1,
          state: task.status === "active" ? "running" : "settled",
          asks: problem === "pending" ? ["human"] : [],
          snapshot: observed,
          context: {
            framing: "Untrusted task evidence",
            task,
            turn: 1,
            evidence: [],
            shared: [],
          },
        };
      };
      try {
        if (problem !== "unstarted") await f.backend.startSupervision(identity);
        const current = (await f.backend.inspect()).bindings[0]!;
        f.observation(current);
        if (problem === "denied")
          f.approve(async () => {
            throw new Error("Denied");
          });
        if (problem === "changed")
          f.approve(async () => {
            f.messages.push({ ...f.messages[0]!, id: "new-input" });
          });
        if (problem === "valid" || problem === "reconciled") {
          const result = await f.backend.resumeTask(current.id, identity);
          expect(result.accepted).toBe(true);
          expect(result.snapshot?.bindings[0]?.status).toBe("active");
          expect(result.snapshot?.bindings[0]?.followups).toBe(
            current.followups,
          );
          expect(nativeReads).toBeGreaterThanOrEqual(2);
          expect(f.asks).toEqual([
            "backseat.start_supervision",
            "backseat.resume",
          ]);
          expect(f.effects).not.toContain("prompt");
          if (problem === "reconciled")
            expect(
              parseCoordinatorState(f.root()).intents[0]?.intent,
            ).toMatchObject({
              id: "initial",
              status: "admitted",
            });
        } else if (problem === "rearm") {
          const result = await f.backend.resumeTask(current.id, identity);
          expect(result.accepted).toBe(false);
          expect(result.reason).toBe("Unreadable rearm inventory");
          expect(result.snapshot?.bindings[0]?.status).toBe("held");
          expect(result.snapshot?.bindings[0]?.followups).toBe(
            current.followups,
          );
          expect(f.effects).not.toContain("prompt");
        } else {
          await expect(
            f.backend.resumeTask(current.id, identity),
          ).rejects.toThrow();
          expect((await f.backend.inspect()).bindings[0]).toEqual(current);
          expect(f.effects).not.toContain("prompt");
        }
      } finally {
        await f.backend.dispose();
      }
    }
    const held = { ...binding, status: "held" as const };
    const eligible = {
      workerID: held.workerID,
      epoch: held.epoch,
      revision: held.revision,
      issues: [],
    };
    const resumed = resumeWorker(held, eligible);
    expect(resumed?.status).toBe("active");
    expect(resumed?.epoch).toBeGreaterThan(held.epoch);
    expect(resumed?.followups).toBe(held.followups);
    for (const invalid of [
      { ...eligible, epoch: held.epoch - 1 },
      { ...eligible, issues: ["Pending human request"] },
      { ...eligible, workerID: "other-worker" },
    ]) {
      expect(() => resumeWorker(held, invalid)).toThrow(
        "Resume is not eligible",
      );
      expect(held.status).toBe("held");
    }
    for (const problem of [
      "exhausted",
      "unresolved",
      "snapshot-changed",
      "denied",
      "failed",
      "valid",
      "pre-idle-prefix-changed",
      "pre-idle-multiple",
      "pre-idle-failed",
      "pre-idle-interrupted",
      "pre-idle-new-work",
      "pre-idle-metadata",
      "pre-idle-after-ask",
      "pre-idle",
    ] as const) {
      const b = {
        ...binding,
        status: "manual" as const,
        ...(problem === "exhausted" ? { followups: 3 } : {}),
      };
      const f = await backendFixture([b], 0, problem === "unresolved");
      try {
        const current = (await f.backend.inspect()).bindings[0]!;
        const terminal = problem.startsWith("pre-idle")
          ? f.messages.pop()
          : undefined;
        const body = f.observation(current);
        if (terminal) f.messages.push(terminal);
        if (
          problem === "pre-idle-prefix-changed" &&
          f.messages[0]?.type === "assistant"
        )
          f.messages[0].content = [
            { type: "text", text: "Different native input" },
          ];
        if (problem === "pre-idle-multiple" && terminal)
          f.messages.push({ ...terminal, id: "idle-2" });
        if (problem === "pre-idle-failed" || problem === "pre-idle-interrupted")
          f.messages[1] = {
            ...f.messages[1]!,
            outcome: problem === "pre-idle-failed" ? "failed" : "interrupted",
          } as SessionMessageInfo;
        const appendWork = async () => {
          f.messages.push({ ...f.messages[0]!, id: "new-work" });
        };
        if (problem === "pre-idle-new-work") await appendWork();
        if (problem === "pre-idle-after-ask") f.approve(appendWork);
        if (problem === "pre-idle-metadata") {
          const get = f.host.session.get;
          f.host.session.get = async (input) => ({
            ...(await get(input)),
            ...(input.sessionID === current.workerID
              ? { outcome: "failed" as const }
              : {}),
          });
        }
        if (problem === "failed")
          f.messages[1] = {
            ...f.messages[1]!,
            outcome: "interrupted",
          } as SessionMessageInfo;
        if (problem === "snapshot-changed")
          f.approve(async () => {
            f.messages.push({ ...f.messages[0]!, id: "idle-2" });
          });
        if (problem === "denied")
          f.approve(async () => {
            throw new Error("Denied");
          });
        if (problem === "valid" || problem === "pre-idle") {
          if (problem === "pre-idle") {
            const stored = [...f.values.values()].find(
              (value) =>
                value && typeof value === "object" && "messageIDs" in value,
            );
            expect(stored).toMatchObject({
              messageIDs: ["assistant-1"],
              nativeBoundary: "assistant-1",
            });
          }
          const result = await f.control("resume", current.id, body).then(
            (result) => ({
              accepted: result.accepted,
              status: result.snapshot?.bindings[0]?.status,
              error: undefined,
            }),
            (error) => ({
              accepted: false,
              status: undefined,
              error: error.message,
            }),
          );
          expect(result).toEqual({
            accepted: true,
            status: "active",
            error: undefined,
          });
          const asks = f.asks.length;
          await expect(
            f.backend.nativeControl(
              "dispatch",
              current.id,
              { text: "Manual work", scope: current.scope },
              {
                sessionID: "coordinator",
                agent: coordinatorAgent.id,
                messageID: "message",
                id: "manual-call",
              },
            ),
          ).rejects.toThrow("requires takeover");
          expect(f.asks).toHaveLength(asks);
          expect(f.effects).not.toContain("prompt");
        } else {
          await expect(f.control("resume", current.id, body)).rejects.toThrow();
          expect((await f.backend.inspect()).bindings[0]).toEqual(current);
          expect(f.asks).toHaveLength(
            ["snapshot-changed", "denied", "pre-idle-after-ask"].includes(
              problem,
            )
              ? 2
              : 1,
          );
        }
        await expect(
          f.backend.nativeControl("resume", current.id, body, {
            sessionID: "coordinator",
            agent: goal.agent,
            messageID: "message",
            id: "native-call",
          }),
        ).rejects.toThrow();
      } finally {
        await f.backend.dispose();
      }
    }
    const projected = await backendFixture([{ ...binding, status: "manual" }]);
    const observer = await createWorkerObserver(
      {
        session: {
          get: projected.host.session.get,
          context: projected.host.session.context!,
        },
        storage: projected.host.storage,
        canonical: projected.host.canonical,
      },
      "/projects/home",
      binding.location,
    );
    try {
      const current = (await projected.backend.inspect()).bindings[0]!;
      const terminal = projected.messages.pop()!;
      await observer.idle({ sessionID: current.workerID, background: [] });
      const hook = (
        await projected.backend.observe({
          taskID: current.id,
          workerID: current.workerID,
        })
      ).snapshot!;
      projected.messages.push(terminal);
      projected.approve(async () => {
        await observer.event({
          id: terminal.id.replace(/^msg_/, "evt_"),
          type: "session.execution.succeeded",
          created: terminal.time.created,
          durable: { aggregateID: current.workerID, seq: 1, version: 1 },
          data: { sessionID: current.workerID },
        });
      });
      const result = await projected
        .control("resume", current.id, {
          reconciliation: {
            generation: (await projected.backend.inspect()).supervision!
              .generation,
            workerID: current.workerID,
            revision: current.revision,
            epoch: current.epoch,
            snapshotFingerprint: fingerprint(hook),
            observedAt: Date.now(),
            state: "settled",
            asks: [],
          },
        })
        .then(
          (result) => ({ accepted: result.accepted, error: undefined }),
          (error) => ({ accepted: false, error: error.message }),
        );
      expect(result).toEqual({ accepted: true, error: undefined });
      expect(
        (
          await projected.backend.observe({
            taskID: current.id,
            workerID: current.workerID,
          })
        ).snapshot,
      ).toEqual(hook);
    } finally {
      await observer.dispose();
      await projected.backend.dispose();
    }
  });
});

async function mockAuthority(scenario: "competing" | "recovery") {
  function lockPort(inspection: LockInspection) {
    const current = structuredClone(inspection);
    const events: string[] = [];
    const port: OwnershipPort = {
      async inspect() {
        return structuredClone(current);
      },
      async acquire(_home, owner) {
        events.push(`acquire:${owner}`);
        current.lock = { owner, running: true };
        return true;
      },
      async release(_home, owner) {
        events.push(`release:${owner}`);
        if (current.lock?.owner === owner) delete current.lock;
      },
      async approveRecovery(_home, owner) {
        events.push(`approval:${owner}`);
      },
      async recover(_home, owner) {
        events.push(`recover:${owner}`);
        if (current.lock?.owner === owner) delete current.lock;
      },
    };
    return { port, events };
  }

  if (scenario === "competing") {
    const available = lockPort({ safe: true });
    const authority = new CoordinatorOwnership(
      "/projects/home",
      "current-owner",
      available.port,
    );
    expect(await authority.claim()).toBe("owned");
    for (const inspection of [
      { safe: false },
      { safe: true, lock: { owner: "other-owner", running: true } },
    ]) {
      const blocked = lockPort(inspection);
      expect(
        await new CoordinatorOwnership(
          "/projects/home",
          "new-owner",
          blocked.port,
        ).claim(),
      ).toBe("held");
      expect(blocked.events).toEqual([]);
    }
    await authority.dispose(async () => {
      available.events.push("drained");
    });
    expect(available.events).toEqual([
      "acquire:current-owner",
      "drained",
      "release:current-owner",
    ]);
    expect(await authority.claim()).toBe("held");
  }

  if (scenario === "recovery") {
    const stale = lockPort({
      safe: true,
      lock: { owner: "stopped-owner", running: false },
    });
    const authority = new CoordinatorOwnership(
      "/projects/home",
      "current-owner",
      stale.port,
    );
    expect(await authority.claim()).toBe("held");
    expect(await authority.recover()).toBe("held");
    expect(stale.events).toEqual([
      "approval:stopped-owner",
      "recover:stopped-owner",
    ]);
    expect(await authority.claim()).toBe("owned");
    const live = lockPort({
      safe: true,
      lock: { owner: "running-owner", running: true },
    });
    await expect(
      new CoordinatorOwnership(
        "/projects/home",
        "new-owner",
        live.port,
      ).recover(),
    ).rejects.toThrow("Recovery is not eligible");
    expect(live.events).toEqual([]);
  }
}

function assertNativeRpcBoundary() {
  const parse = BackseatRpc.methods.identity.input["~standard"].validate;
  const input = { nonce: "a".repeat(64), origin: "fixture" };
  expect(parse(input)).toEqual({ value: input });
  for (const invalid of [
    { ...input, nonce: "short" },
    { ...input, origin: "x".repeat(201) },
    { ...input, confirmed: true },
  ])
    expect(parse(invalid)).toHaveProperty("issues");
}

// spec: openspec/specs/worker-coordination/spec.md
describe("Approved observer generation", () => {
  it("Native approval binds observer generation", async () => {
    const f = await backendFixture([], 0, false, false);
    try {
      const first = await f.backend.startSupervision(nativeIdentity());
      expect(first).toEqual({
        generation: 1,
        coordinatorID: "coordinator",
        status: "held",
      });
      expect(f.asks).toEqual(["backseat.start_supervision"]);
      expect(
        (
          await f.backend.startSupervision({
            ...nativeIdentity(),
            id: "replacement",
          })
        ).generation,
      ).toBe(2);
      expect(f.effects).not.toContain("prompt");
    } finally {
      await f.backend.dispose();
    }
    for (const change of [
      "denied",
      "projectID",
      "workspaceID",
      "cancelled",
    ] as const) {
      const f = await backendFixture([], 0, false, false);
      try {
        const abort = new AbortController();
        const get = f.host.session.get;
        let changed = false;
        f.host.session.get = async (input) => {
          const session = await get(input);
          if (!changed || input.sessionID !== "coordinator") return session;
          return {
            ...session,
            ...(change === "projectID" ? { projectID: "changed" } : {}),
            location: {
              ...session.location,
              ...(change === "workspaceID" ? { workspaceID: "changed" } : {}),
            },
          };
        };
        f.approve(async () => {
          if (change === "denied") throw new Error("Denied");
          if (change === "cancelled") abort.abort();
          changed = true;
        });
        await expect(
          f.backend.startSupervision({
            ...nativeIdentity(),
            signal: abort.signal,
          }),
        ).rejects.toThrow();
        expect(f.effects).not.toContain("prompt");
        expect((await f.backend.inspect()).supervision).toBeUndefined();
      } finally {
        await f.backend.dispose();
      }
    }
    const incumbent = await backendFixture();
    try {
      const before = incumbent.root();
      incumbent.approve(async () => {
        throw new Error("Denied replacement");
      });
      await expect(
        incumbent.backend.startSupervision(nativeIdentity()),
      ).rejects.toThrow("Denied replacement");
      expect(incumbent.root()).toEqual(before);
      incumbent.approve(async () => {});
      await incumbent.backend.startSupervision(nativeIdentity());
      expect((await incumbent.backend.inspect()).supervision?.generation).toBe(
        2,
      );
    } finally {
      await incumbent.backend.dispose();
    }
  });
  it("Rejects unapproved observer mutations", async () => {
    const f = await backendFixture(
      [
        {
          ...goal,
          workerID: "worker",
          revision: 1,
          epoch: 1,
          status: "held",
          followups: 2,
          nonprogress: 1,
        },
      ],
      0,
      false,
      false,
    );
    try {
      const before = f.root();
      await expect(
        f.backend.resumeTask(goal.id, nativeIdentity()),
      ).rejects.toThrow();
      await expect(
        f.backend.startSupervision({
          ...nativeIdentity(),
          sessionID: "worker",
        }),
      ).rejects.toThrow();
      for (const operation of ["reserve", "finish", "record"] as const)
        await expect(
          f.backend.nativeControl(operation, goal.id, {}, nativeIdentity()),
        ).rejects.toThrow();
      expect(f.root()).toEqual(before);
      expect(f.effects).not.toContain("prompt");
      await f.backend.startSupervision(nativeIdentity());
      expect((await f.backend.inspect()).bindings[0]).toMatchObject({
        status: "held",
        followups: 2,
        nonprogress: 1,
      });
      assertNativeRpcBoundary();
    } finally {
      await f.backend.dispose();
    }
  });
});
