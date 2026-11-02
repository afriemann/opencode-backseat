import { describe, expect, it } from "bun:test";
import {
  applyNativeNoColor,
  CoordinationUI,
  coordinationStatusDetails,
  describeOverview,
  overview,
  sharedVersionDetails,
  type NativeUiPort,
  type UiOption,
  type NativePaintSurface,
} from "../src/ui.ts";
import { RGBA } from "@opentui/core";
import type { WorkerBinding } from "../src/state.ts";
import {
  setupNativeTui,
  NativeDiscovery,
  readNativeAsks,
  readNativeObservation,
  readNativeDelivery,
  type NativeCatalogClient,
  type NativeAskClient,
  type NativeRuntimeContext,
  type NativeRuntimeClient,
} from "../src/tui.ts";
import type {
  DialogSelectOptions,
  KeymapCommand,
} from "@opencode/plugin/tui/context";
import { verify } from "node:crypto";
import type {
  RpcCallOptions,
  SessionMessageInfo,
  SessionMessageAssistantTool,
  SessionPromptInput,
  ExperimentalSessionLogOutput,
  OpenCodeEvent,
  PermissionRequest,
} from "@opencode/client";
import type { CoordinatorSnapshot, ControlInput } from "../src/rpc.ts";
import { captureNativeOverview, fixtureApproval } from "./host.ts";
import {
  createNativeBackend,
  createWorkerObserver,
  type NativeBackendHost,
} from "../src/server.ts";
import { CoordinatorOwnership } from "../src/ownership.ts";
import { fingerprint, nativeToolEvidence } from "../src/context.ts";
import type { Suggestion } from "../src/evaluator.ts";

const task: WorkerBinding = {
  id: "api-task",
  title: "api",
  goal: "update endpoint",
  criteria: ["Response verified"],
  constraints: [],
  scope: ["Endpoint"],
  location: "/projects/api",
  agent: "engineer",
  group: "migration",
  workerID: "worker-api",
  revision: 1,
  epoch: 1,
  status: "held",
  followups: 0,
  nonprogress: 0,
  shared: [{ id: "contract", version: 3 }],
};

function fixture() {
  const calls: string[] = [];
  const notices: string[] = [];
  const choices: unknown[] = [
    { id: "api", title: "api", location: "/projects/api" },
    "engineer",
    "worker-api",
  ];
  const port: NativeUiPort = {
    select: async <T>(title: string, options: readonly UiOption<T>[]) => {
      calls.push(title);
      const choice = choices.shift() as T | undefined;
      expect(
        options.some(
          (option) =>
            option.value === choice ||
            JSON.stringify(option.value) === JSON.stringify(choice),
        ),
      ).toBe(true);
      return choice;
    },
    notice: async (state, reason) => {
      notices.push(`${state}: ${reason}`);
    },
    projects: async () => [
      { id: "api", title: "api", location: "/projects/api" },
    ],
    agents: async (location) => {
      calls.push(`agents:${location}`);
      return ["engineer"];
    },
    workers: async (location, agent) => {
      calls.push(`workers:${location}:${agent}`);
      return [{ workerID: "worker-api", title: "api", location, agent }];
    },
    open: (workerID) => {
      calls.push(`open:${workerID}`);
      return true;
    },
    control: async (action, binding) => ({
      ...binding,
      status: action === "takeover" ? "manual" : "held",
      epoch: binding.epoch + 1,
    }),
  };
  return { port, calls, notices, choices };
}

// Native ports are typed from the installed 2.2.5 declarations. Unused host
// surfaces are intentionally absent; this fake is not a renderer capture.
function runtimeFixture() {
  const commands: KeymapCommand[] = [];
  const dialogs: DialogSelectOptions<unknown>[] = [];
  const notices: string[] = [];
  const controls: ControlInput[] = [];
  const focused: string[] = [];
  const inputs: unknown[] = [];
  const messages: SessionMessageInfo[] = [];
  const logs: ExperimentalSessionLogOutput[] = [];
  const permissions: PermissionRequest[] = [];
  const requests: RpcCallOptions[] = [];
  const signals: AbortSignal[] = [];
  const nativeEvents: OpenCodeEvent[] = [];
  let wake: (() => void) | undefined;
  let listener: ((event: { details: OpenCodeEvent }) => void) | undefined;
  const snapshot: CoordinatorSnapshot = {
    version: 1,
    home: "/tmp/opencode",
    authority: "owned",
    bindings: [structuredClone(task)],
    snapshots: [
      {
        id: "contract",
        version: 3,
        group: "migration",
        content: "Approved contract",
        recipients: [task.id],
      },
    ],
    intents: [],
    completions: [],
  };
  let denied = false;
  const rpc = {
    inspect: async (
      _input: Record<string, never>,
      options?: RpcCallOptions,
    ) => {
      if (options) requests.push(options);
      return structuredClone(snapshot);
    },
    attach: async (input: { coordinatorID: string; verifier: string }) => {
      snapshot.observer = { ...input, generation: 7, sequence: 0 };
      return { generation: 7 };
    },
    control: async (input: ControlInput) => {
      controls.push(input);
      if (snapshot.observer) snapshot.observer.sequence = input.proof.sequence;
      if (denied) throw new Error("Native approval denied");
      snapshot.bindings = snapshot.bindings.map((binding) =>
        binding.id === input.taskID
          ? {
              ...binding,
              status: input.operation === "takeover" ? "manual" : "held",
              epoch: binding.epoch + 1,
            }
          : binding,
      );
      return { accepted: true, snapshot: structuredClone(snapshot) };
    },
    recover: async () => structuredClone(snapshot),
    suggest: async () => ({ reason: "unsupported evidence" }),
    observe: async () => ({ reason: "Missing worker observer" }),
    validate: async () => {
      throw new Error("Unexpected validation");
    },
    events: { subscribe: async function* () {}, on: () => () => {} },
  };
  const session = {
    id: "coordinator",
    projectID: "home",
    agent: "engineer",
    location: { directory: "/tmp/opencode" },
    time: { created: 1, updated: 1 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const context: NativeRuntimeContext = {
    options: {},
    location: { directory: "/tmp/opencode" },
    client: {
      rpc: () => rpc,
      project: {
        list: async () => [
          {
            id: "api",
            name: "api",
            canonical: task.location,
            sandboxes: [],
            time: { created: 1, updated: 1, active: 1 },
          },
        ],
      },
      agent: {
        list: async () => ({
          location: { directory: task.location },
          data: [
            {
              id: "engineer",
              name: "engineer",
              hidden: false,
              mode: "all",
              request: { settings: {}, headers: {}, body: {} },
              permissions: [],
            },
          ],
        }),
      },
      session: {
        create: async () => ({ ...session, id: "created-coordinator" }),
        get: async ({ sessionID }: { sessionID: string }) =>
          sessionID === "coordinator"
            ? session
            : {
                ...session,
                id: task.workerID,
                location: { directory: task.location },
              },
        list: async () => ({
          data: [
            {
              ...session,
              id: task.workerID,
              title: "api",
              location: { directory: task.location },
            },
          ],
          cursor: {},
        }),
        active: async () => ({}),
        inbox: { list: async () => [] },
        context: async () => structuredClone(messages),
        form: {
          list: async () => [],
          get: async () => {
            throw new Error("No form");
          },
        },
        prompt: async () => {
          throw new Error("Unexpected automatic admission");
        },
      },
      permission: {
        request: {
          list: async (input) => ({
            location: {
              directory: input?.location?.directory ?? task.location,
            },
            data: permissions,
          }),
        },
      },
      message: { list: async () => ({ data: messages, cursor: {} }) },
      shell: {
        list: async () => ({
          location: { directory: task.location },
          data: [],
        }),
      },
      experimental: {
        session: {
          log: async function* (input) {
            yield* logs;
            yield { type: "log.synced" as const, aggregateID: input.sessionID };
          },
        },
      },
      event: {
        subscribe: async function* (
          options: Parameters<
            NativeRuntimeContext["client"]["event"]["subscribe"]
          >[0],
        ) {
          if (options?.signal) signals.push(options.signal);
          options?.signal?.addEventListener("abort", () => wake?.(), {
            once: true,
          });
          while (!options?.signal?.aborted) {
            if (!nativeEvents.length)
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            const event = nativeEvents.shift();
            if (
              event &&
              event.type !== "server.connected" &&
              (!options?.types || options.types.includes(event.type))
            )
              yield event;
          }
        } as NativeRuntimeContext["client"]["event"]["subscribe"],
      },
    },
    data: {
      listen: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    },
    renderer: { width: 80 },
    keymap: {
      layer: (factory: () => { commands?: readonly KeymapCommand[] }) => {
        commands.push(...(factory().commands ?? []));
      },
    },
    ui: {
      router: {
        current: () => ({ type: "session", sessionID: "coordinator" }),
        navigate: () => {},
      },
      tabs: {
        focus: (id: string) => {
          focused.push(id);
          return true;
        },
      },
      toast: {
        show: ({ message }: { message: string }) => {
          notices.push(message);
        },
      },
      dialog: {
        select: async <T>(
          options: DialogSelectOptions<T>,
        ): Promise<T | undefined> => {
          dialogs.push(options as DialogSelectOptions<unknown>);
          return inputs.shift() as T | undefined;
        },
        prompt: async () => inputs.shift() as string | undefined,
        clear: () => {},
      },
    },
  } satisfies NativeRuntimeContext;
  const close = setupNativeTui(context);
  const run = async (id: string, input?: string) => {
    await commands.find((command) => command.id === id)?.run(input);
  };
  return {
    commands,
    dialogs,
    notices,
    controls,
    focused,
    inputs,
    messages,
    logs,
    permissions,
    requests,
    signals,
    context,
    rpc,
    run,
    close,
    async nativeEmit(details: OpenCodeEvent) {
      nativeEvents.push(details);
      wake?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    emit: (details: OpenCodeEvent) => listener?.({ details }),
    deny: () => {
      denied = true;
    },
    snapshot: () => snapshot,
  };
}

function startupFixture(
  origin:
    "home" | "valid" | "worker" | "wrong" | "archived" | "missing" = "home",
) {
  const f = runtimeFixture();
  f.snapshot().bindings = [];
  let route: ReturnType<NativeRuntimeContext["ui"]["router"]["current"]> =
    origin === "home"
      ? { type: "home" }
      : {
          type: "session",
          sessionID: origin === "worker" ? task.workerID : "coordinator",
        };
  if (origin === "worker") f.snapshot().bindings = [structuredClone(task)];
  const get = f.context.client.session.get;
  const events: string[] = [];
  const creates: Parameters<NativeRuntimeClient["session"]["create"]>[0][] = [];
  const rpc = f.rpc;
  const attach = rpc.attach;
  let deny = false,
    failNavigation = false,
    unknownCreation = false;
  f.context.ui.router.current = () => route;
  f.context.ui.router.navigate = (destination) => {
    events.push("navigate");
    if (failNavigation) throw new Error("Navigation failed");
    if (destination.type !== "plugin") route = destination;
  };
  f.context.client.session.create = async (input) => {
    events.push("create");
    creates.push(input);
    if (unknownCreation) throw new Error("Creation acknowledgement lost");
    return {
      ...(await get({ sessionID: "coordinator" })),
      id: "created-coordinator",
    };
  };
  f.context.client.session.get = async (input) => {
    if (origin === "missing" && input.sessionID === "coordinator")
      throw new Error("Current session no longer exists");
    if (input.sessionID === "created-coordinator")
      return {
        ...(await get({ sessionID: "coordinator" })),
        id: input.sessionID,
      };
    const value = await get(input);
    return input.sessionID === "coordinator"
      ? {
          ...value,
          ...(origin === "wrong" ? { location: { directory: "/" } } : {}),
          time: {
            ...value.time,
            ...(origin === "archived" ? { archived: 1 } : {}),
          },
        }
      : value;
  };
  rpc.attach = async (input) => {
    events.push("approve");
    if (deny) throw new Error("Native approval denied");
    expect(route).toEqual({ type: "session", sessionID: input.coordinatorID });
    return attach(input);
  };
  return {
    ...f,
    events,
    creates,
    deny: () => {
      deny = true;
    },
    navigation: (failed: boolean) => {
      failNavigation = failed;
    },
    unknownCreation: () => {
      unknownCreation = true;
    },
  };
}

// spec: openspec/specs/coordination-tui/spec.md
describe("Guided coordinator startup", () => {
  it("Starts from a blank coordinator without a prompt", async () => {
    if (process.env.CONMAN_NATIVE_HOST_TESTS === "1") {
      for (const width of [80, 32]) {
        const native = await captureNativeOverview(
          [],
          width,
          24,
          false,
          {},
          false,
          "disconnected",
          false,
          undefined,
          false,
          "session",
        );
        expect(native.frame.text).toContain("Get started");
        expect(native.frame.text).toContain("Setup: unattached");
        expect(native.frame.text).toContain("No workers available");
        expect(native.sessionChoice?.text).toContain("Create coordinator");
        expect(native.sessionChoice?.text).toContain("Inspect home");
        expect(native.startupProof?.messages).toBe(0);
        expect(native.startupProof?.homeReadable).toBe(true);
        expect(native.startupProof?.location).toBe(
          native.startupProof?.canonicalHome,
        );
        expect(native.startupProof?.sessionID).toStartWith("ses_");
      }
    }
    for (const origin of [
      "missing",
      "home",
      "valid",
      "worker",
      "wrong",
      "archived",
    ] as const) {
      const f = startupFixture(origin);
      try {
        await f.run("conman.overview");
        expect(f.creates).toHaveLength(0);
        f.inputs.push(
          "home",
          undefined,
          origin === "valid" ? "reuse" : "create",
          "not-now",
        );
        await f.run("conman.start");
        expect(f.events).toEqual(
          origin === "valid" ? ["approve"] : ["create", "navigate", "approve"],
        );
        expect(f.creates).toEqual(
          origin === "valid"
            ? []
            : [
                {
                  title: "Coordinator",
                  location: { directory: "/tmp/opencode" },
                },
              ],
        );
        expect(
          f.dialogs
            .find((dialog) => dialog.title === "Canonical home (read only)")
            ?.options.map((option) => option.title)
            .join(""),
        ).toBe("/tmp/opencode");
        expect(f.dialogs[0]?.options).toContainEqual(
          expect.objectContaining({
            title: "Get started",
            value: "conman:get-started",
          }),
        );
        expect(
          f.controls.some((control) =>
            ["create", "adopt", "reserve"].includes(control.operation),
          ),
        ).toBe(false);
      } finally {
        f.close();
      }
    }
  });
  it("Keeps approval and arming separate", async () => {
    if (process.env.CONMAN_NATIVE_HOST_TESTS === "1") {
      for (const width of [80, 32]) {
        const native = await captureNativeOverview(
          [],
          width,
          24,
          true,
          {},
          false,
          "awaiting-rearm",
          false,
          undefined,
          false,
          "supervision",
        );
        expect(native.frame.text).toContain("Start supervision");
        expect(native.frame.text).toContain("Not now");
      }
    }
    for (const mode of ["cancel", "deny", "not-now", "start"] as const) {
      const f = startupFixture();
      try {
        if (mode === "deny") f.deny();
        if (mode !== "cancel")
          f.inputs.push("create", mode === "start" ? "start" : "not-now");
        await f.run("conman.start");
        expect(f.events.filter((value) => value === "approve")).toHaveLength(
          mode === "cancel" ? 0 : 1,
        );
        expect(f.notices.some((value) => value.startsWith("ready:"))).toBe(
          mode === "start",
        );
        expect(f.snapshot().observer !== undefined).toBe(
          mode === "start" || mode === "not-now",
        );
        expect(f.controls).toHaveLength(0);
        if (mode === "deny")
          expect(f.notices.join("\n")).toContain("Native approval denied");
        if (mode === "deny") {
          expect(
            (
              await f.context.client.session.get({
                sessionID: "created-coordinator",
              })
            ).id,
          ).toBe("created-coordinator");
          f.inputs.length = 0;
          f.inputs.push("reuse");
          await f.run("conman.start");
          expect(f.creates).toHaveLength(1);
          expect(f.snapshot().observer).toBeUndefined();
        }
        if (mode === "cancel") {
          await f.run("conman.overview");
          expect(f.dialogs.at(-1)?.options).toContainEqual(
            expect.objectContaining({
              title: "No workers available",
              value: "conman:status",
              disabled: false,
            }),
          );
        }
      } finally {
        f.close();
      }
    }
  });
  it("Reuses confirmed sessions after interrupted startup", async () => {
    const queued = startupFixture();
    try {
      let entered!: () => void, release!: () => void;
      const creating = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const create = queued.context.client.session.create;
      queued.context.client.session.create = async (input) => {
        entered();
        await pending;
        return create(input);
      };
      queued.inputs.push("create", "not-now", "not-now");
      const first = queued.run("conman.start");
      await creating;
      const second = queued.run("conman.start");
      release();
      await Promise.all([first, second]);
      expect(queued.creates).toHaveLength(1);
      expect(queued.events.filter((value) => value === "approve")).toHaveLength(
        1,
      );
      expect(queued.notices.some((value) => value.startsWith("error:"))).toBe(
        false,
      );
    } finally {
      queued.close();
    }
    for (const mode of [
      "attached",
      "navigation",
      "unknown",
      "reconnect",
    ] as const) {
      const f = startupFixture();
      try {
        if (mode === "navigation") f.navigation(true);
        if (mode === "unknown") f.unknownCreation();
        f.inputs.push(
          "create",
          ...(mode === "navigation" || mode === "unknown" ? [] : ["not-now"]),
        );
        await f.run("conman.start");
        if (mode === "navigation") {
          f.navigation(false);
          f.inputs.push("reuse", "not-now");
        } else if (mode === "unknown") f.inputs.push("create");
        else if (mode === "reconnect") {
          f.emit({ id: "connected", type: "server.connected", data: {} });
          f.inputs.push("reuse", "not-now");
        } else f.inputs.push("not-now");
        await f.run("conman.start");
        expect(f.creates).toHaveLength(1);
        expect(f.events.filter((value) => value === "approve")).toHaveLength(
          mode === "unknown" ? 0 : mode === "reconnect" ? 2 : 1,
        );
        expect(f.controls).toHaveLength(0);
      } finally {
        f.close();
      }
    }
  });
});

// Real repository observer/backend at the verified SDK boundary, not an accepting
// validation fake. No native host is launched or project configuration activated.
async function supervisedRuntime(action: "continue" | "complete") {
  const f = runtimeFixture();
  f.close();
  f.commands.length = 0;
  f.context.location = { directory: task.location };
  const values = new Map<string, unknown>();
  const home = "/tmp/opencode";
  const activeTask = { ...task, status: "active" as const };
  const sessionGet = f.context.client.session.get;
  f.context.client.session.get = async (input) => {
    const session = await sessionGet(input);
    return session.id === task.workerID
      ? {
          ...session,
          outcome: "succeeded",
          time: { ...session.time, busy: 1, idle: 3 },
        }
      : session;
  };
  values.set(`home:${encodeURIComponent(home)}:state`, {
    version: 1,
    bindings: [activeTask],
    snapshots: f.snapshot().snapshots,
    intents: [],
    completions: [],
  });
  const call: SessionMessageAssistantTool = {
    type: "tool",
    id: "result",
    name: "shell",
    time: { created: 1, ran: 1, completed: 2 },
    state: {
      status: "completed" as const,
      input: { command: "check endpoint" },
      content: [{ type: "text" as const, text: "Response verified" }],
    },
  };
  f.messages.push(
    {
      id: "step",
      type: "assistant",
      agent: task.agent,
      model: { id: "model", providerID: "provider" },
      time: { created: 1, completed: 2 },
      content: [call],
    },
    { id: "idle", type: "idle", outcome: "succeeded", time: { created: 3 } },
  );
  f.logs.push(
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
  );
  if (action === "complete") {
    f.messages.splice(1, 0, {
      id: "summary",
      type: "assistant",
      agent: task.agent,
      model: { id: "model", providerID: "provider" },
      time: { created: 2, completed: 3 },
      content: [{ type: "text", text: "Endpoint verification finished" }],
    });
    f.logs.splice(2, 0, {
      id: "summary-step",
      created: 2,
      type: "session.step.started",
      durable: { aggregateID: task.workerID, seq: 3, version: 1 },
      data: {
        sessionID: task.workerID,
        assistantMessageID: "summary",
        agent: task.agent,
        model: { id: "model", providerID: "provider" },
        started: 2,
      },
    });
    const terminal = f.logs.at(-1)!;
    if (terminal.type !== "log.synced") terminal.durable.seq = 4;
  }
  const generated: string[] = [],
    admissions: SessionPromptInput[] = [];
  const reasoningReasons: string[] = [];
  const entry = nativeToolEvidence("step", call)!;
  let duringValidation = async () => {};
  let duringResumeApproval = async () => {};
  let judgment: unknown =
    action === "complete"
      ? {
          status: "accept",
          rationale: "Inspected native endpoint result supports the criterion",
          criteria: [
            {
              criterion: task.criteria[0],
              status: "accept",
              rationale: "Actual command/result match",
              evidence: [entry.native],
            },
          ],
        }
      : {
          status: "accept",
          rationale:
            "Exact endpoint verification is in scope and non-consenting",
        };
  const suggestion: Suggestion =
    action === "complete"
      ? {
          taskID: task.id,
          workerID: task.workerID,
          action,
          support: [{ criterion: task.criteria[0]!, evidenceID: entry.id }],
        }
      : {
          taskID: task.id,
          workerID: task.workerID,
          action,
          nextStep: "Verify endpoint response",
          scope: [...task.scope],
          progress: true,
        };
  const host: NativeBackendHost = {
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
    session: {
      get: f.context.client.session.get,
      context: f.context.client.session.context,
      async create() {
        throw new Error("Unexpected create");
      },
      async prompt() {
        throw new Error("Backend cannot prompt");
      },
    },
    agent: f.context.client.agent,
    permission: {
      async assert(input) {
        await fixtureApproval(home).assert(input);
        if (input.action === "conman.resume") await duringResumeApproval();
      },
    },
    async canonical(path) {
      return path;
    },
    async generate(_context, validation) {
      generated.push(validation ? "validate" : "suggest");
      if (validation) {
        await duringValidation();
        return judgment;
      }
      return suggestion;
    },
  };
  const owner = new CoordinatorOwnership(home, "runtime-test", {
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
  const backend = await createNativeBackend(host, owner, home);
  const observer = await createWorkerObserver(
    {
      ...host,
      session: {
        get: host.session.get,
        context: f.context.client.session.context,
      },
    },
    home,
    task.location,
  );
  await observer.idle({ sessionID: task.workerID, background: [] });
  type RpcBoundary = ReturnType<NativeRuntimeContext["client"]["rpc"]>;
  const controllerRpc: { -readonly [K in keyof RpcBoundary]: RpcBoundary[K] } =
    {
      inspect: async (_input, options) => {
        if (options) f.requests.push(options);
        const result = await backend.inspect();
        return options?.location?.directory === task.location
          ? { ...result, authority: "passive" as const }
          : result;
      },
      attach: (input) => backend.attach(input),
      control: async (input) => {
        f.controls.push(input);
        return backend.control(input);
      },
      suggest: async (input) => {
        try {
          const result = await backend.suggest(input);
          if (result.reason) reasoningReasons.push(result.reason);
          return result;
        } catch (error) {
          reasoningReasons.push(
            error instanceof Error ? error.message : "Reasoning request failed",
          );
          throw error;
        }
      },
      observe: (input) => backend.observe(input),
      validate: (input) => backend.validate(input),
      recover: (input) => backend.recover(input),
      events: { subscribe: async function* () {}, on: () => () => {} },
    };
  f.context.client.rpc = () => controllerRpc;
  f.context.client.session.prompt = async (input) => {
    const state = await backend.inspect();
    expect(state.intents.at(-1)?.intent.id).toBe(input.id ?? undefined);
    expect(state.bindings[0]?.followups).toBe(1);
    admissions.push(input);
    f.messages.push({
      id: "own-next-step",
      type: "assistant",
      agent: task.agent,
      model: { id: "model", providerID: "provider" },
      time: { created: 4 },
      content: [],
    });
    f.logs.push({
      id: "next-step",
      created: 4,
      type: "session.step.started",
      durable: { aggregateID: task.workerID, seq: 4, version: 1 },
      data: {
        sessionID: task.workerID,
        assistantMessageID: "own-next-step",
        agent: task.agent,
        model: { id: "model", providerID: "provider" },
        started: 4,
      },
    });
    return {
      id: input.id!,
      sessionID: input.sessionID,
      time: { created: 4 },
      type: "user",
      payload: { text: input.text },
      delivery: "queue",
    };
  };
  const close = setupNativeTui(f.context);
  return {
    ...f,
    backend,
    observer,
    generated,
    reasoningReasons,
    admissions,
    entry,
    call,
    suggestion,
    controllerRpc,
    setJudgment(value: unknown) {
      judgment = value;
    },
    onValidation(fn: () => Promise<void>) {
      duringValidation = fn;
    },
    onResumeApproval(fn: () => Promise<void>) {
      duringResumeApproval = fn;
    },
    async ready() {
      await f.run("conman.attach");
      await f.run("conman.resume", task.workerID);
      await f.run("conman.rearm");
    },
    async supervise() {
      await f.nativeEmit({
        id: "idle-event",
        created: 3,
        type: "session.idle",
        data: { sessionID: task.workerID },
      });
      await f.run("conman.overview");
    },
    async cleanup() {
      close();
      await observer.dispose();
      await backend.dispose();
    },
  };
}

// spec: openspec/specs/coordination-tui/spec.md
async function assertExactNativeDeliveryIdentity() {
  for (const source of [
    "inbox",
    "history",
    "wrong-id",
    "wrong-session",
    "assistant",
  ] as const) {
    const f = runtimeFixture();
    try {
      const intent = {
        id: "msg_reserved-original",
        taskID: task.id,
        workerID: task.workerID,
        identity: "persisted-decision",
        text: "Verify endpoint",
        nonprogress: 0,
        status: "ambiguous" as const,
      };
      if (source === "inbox" || source === "wrong-session")
        f.context.client.session.inbox.list = async () => [
          {
            id: intent.id,
            sessionID:
              source === "wrong-session" ? "other-worker" : task.workerID,
            type: "user",
            time: { created: 4 },
            payload: { text: intent.text },
            delivery: "queue",
          },
        ];
      else if (source === "assistant")
        f.messages.push({
          id: intent.id,
          type: "assistant",
          agent: task.agent,
          model: { id: "model", providerID: "provider" },
          time: { created: 4 },
          content: [{ type: "text", text: intent.text }],
        });
      else {
        const delivered = {
          id: source === "wrong-id" ? "msg_unrelated" : intent.id,
          type: "user" as const,
          time: { created: 4 },
          text: intent.text,
        };
        f.context.client.message.list = async (input) => {
          if (input.cursor) {
            expect(input.order).toBeUndefined();
            return { data: [delivered], cursor: {} };
          }
          return { data: [], cursor: { next: "actual-next-cursor" } };
        };
      }
      expect(
        await readNativeDelivery(
          f.context.client,
          task,
          intent,
          new AbortController().signal,
        ),
        source,
      ).toBe(
        source === "inbox" || source === "history" ? "admitted" : "unknown",
      );
    } finally {
      f.close();
    }
  }
}

async function assertResumeApprovalRechecks() {
  for (const failure of ["denied", "changed-context", "new-ask"] as const) {
    const f = await supervisedRuntime("continue");
    try {
      await f.run("conman.attach");
      const before = (await f.backend.inspect()).bindings[0]!;
      f.onResumeApproval(async () => {
        if (failure === "denied") throw new Error("Native approval denied");
        if (failure === "changed-context")
          f.messages.push({
            id: "new-native-input",
            type: "user",
            text: "New human input",
            time: { created: 4 },
          });
        if (failure === "new-ask")
          f.permissions.push({
            id: "ask-at-approval",
            sessionID: task.workerID,
            action: "shell",
            resources: [task.location],
          });
      });
      await f.run("conman.resume", task.workerID);
      const after = (await f.backend.inspect()).bindings[0]!;
      if (failure === "new-ask") {
        expect(after.status).toBe("held");
        expect(after.followups).toBe(before.followups);
        expect(after.nonprogress).toBe(before.nonprogress);
      } else expect(after, failure).toEqual(before);
      expect(f.admissions, failure).toHaveLength(0);
      expect(f.generated, failure).toHaveLength(0);
      expect(
        f.notices.some((notice) => /denied|changed/i.test(notice)),
        failure,
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  }
}

async function assertLocalObserverFailureFences() {
  const failures: string[] = [];
  for (const mode of [
    "status-inspect",
    "overview-inspect",
    "overview-observation",
    "obsolete-home",
    "obsolete-generation",
    "recover-home",
  ] as const) {
    const f = await supervisedRuntime("continue");
    try {
      await f.ready();
      const before = await f.backend.inspect();
      const inspect = f.controllerRpc.inspect;
      const get = f.context.client.session.get;
      const control = f.controllerRpc.control;
      if (mode === "recover-home") {
        f.controllerRpc.recover = async () => ({
          ...(await f.backend.inspect()),
          home: "/unapproved-home",
        });
        await f.run("conman.recover");
        expect(f.notices.at(-1)).toMatch(/canonical.*home|home.*canonical/i);
        expect(await f.backend.inspect()).toEqual(before);
        continue;
      }
      if (mode === "status-inspect" || mode === "overview-inspect")
        f.controllerRpc.inspect = async () => {
          throw new Error("Native inventory unreadable");
        };
      if (mode === "overview-observation")
        f.context.client.session.get = async (input, options) => {
          if (input.sessionID === task.workerID)
            throw new Error("Worker inventory unreadable");
          return get(input, options);
        };
      if (mode === "obsolete-home" || mode === "obsolete-generation") {
        f.controllerRpc.control = async (input) => {
          const result = await control(input);
          return {
            ...result,
            snapshot:
              mode === "obsolete-home"
                ? { ...result.snapshot, home: "/unapproved-home" }
                : {
                    ...result.snapshot,
                    observer: {
                      ...result.snapshot.observer!,
                      generation: result.snapshot.observer!.generation + 1,
                    },
                  },
          };
        };
        f.inputs.push(JSON.stringify({ shared: [] }));
        await f.run("conman.share", task.workerID);
        expect(f.notices.at(-1)).toContain("obsolete");
      } else {
        await f.run(
          mode === "status-inspect" ? "conman.status" : "conman.overview",
        );
        expect(await f.backend.inspect()).toEqual(before);
      }
      f.controllerRpc.inspect = inspect;
      f.context.client.session.get = get;
      f.controllerRpc.control = control;
      const enabled = f.commands.find(
        (command) => command.id === "conman.rearm",
      )?.enabled;
      expect(typeof enabled === "function" ? enabled() : enabled).toBe(false);
      const fenced = await f.backend.inspect();
      const controlCount = f.controls.length;
      await f.run("conman.rearm");
      await f.run("conman.hold", task.workerID);
      await f.supervise();
      expect(f.generated).toEqual([]);
      expect(f.admissions).toEqual([]);
      expect(f.controls).toHaveLength(controlCount);
      expect(await f.backend.inspect()).toEqual(fenced);
      await f.observer.idle({ sessionID: task.workerID, background: [] });
      await f.run("conman.attach");
      await f.run("conman.rearm");
      await f.supervise();
      expect(f.generated).toEqual(["suggest", "validate"]);
      expect(f.admissions).toHaveLength(1);
    } catch (error) {
      failures.push(`${mode}: ${String(error)}`);
    } finally {
      await f.cleanup();
    }
  }
  expect(failures).toEqual([]);
}

describe("Native project and worker selection", () => {
  it("Selects a project-specific agent and worker", async () => {
    if (process.env.CONMAN_NATIVE_HOST_TESTS === "1") {
      const discovery = await captureNativeOverview(
        [task],
        80,
        24,
        false,
        {},
        false,
        "ready",
        false,
        undefined,
        true,
      );
      expect(discovery.frame.commands).toContainEqual(
        expect.objectContaining({ id: "conman.overview" }),
      );
      expect(discovery.frame.text).toContain("Coordinate / search");
      expect(discovery.frame.text).toContain("Coordinate: open worker");
      expect(discovery.slash?.text).toContain("/coordinate");
    }
    const passive = await supervisedRuntime("continue");
    await passive.ready();
    expect(passive.requests[0]?.location?.directory).toBe(task.location);
    expect(
      passive.requests
        .slice(1)
        .every((request) => request.location?.directory === "/tmp/opencode"),
    ).toBe(true);
    expect(
      passive.notices.some((notice) => notice.includes("explicitly rearmed")),
    ).toBe(true);
    await passive.cleanup();
    const f = fixture();
    const selected = await new CoordinationUI(f.port).selectTarget("adopt");
    expect(selected).toEqual({
      workerID: "worker-api",
      title: "api",
      location: "/projects/api",
      agent: "engineer",
    });
    if (!selected) throw new Error("Expected the selected worker");
    expect(f.calls).toContain("agents:/projects/api");
    expect(f.calls).toContain("workers:/projects/api:engineer");
    // Fixture fields derive from installed @opencode/client 2.2.5 declarations.
    const nativeCalls: string[] = [];
    const client: NativeCatalogClient = {
      project: {
        list: async () => [
          {
            id: "api",
            name: "api",
            canonical: "/projects/api",
            sandboxes: ["/projects/api/.worktrees/change"],
            time: { created: 1, updated: 1, active: 1 },
          },
        ],
      },
      agent: {
        list: async (input) => {
          nativeCalls.push(`agents:${input?.location?.directory}`);
          return {
            location: { directory: "/projects/api" },
            data: [
              {
                id: "engineer",
                name: "engineer",
                mode: "all",
                hidden: false,
                request: { settings: {}, headers: {}, body: {} },
                permissions: [],
              },
            ],
          };
        },
      },
      session: {
        list: async (input) => {
          nativeCalls.push(`workers:${input?.directory}`);
          return {
            data: [
              {
                id: "worker-api",
                projectID: "api",
                agent: "engineer",
                title: "api",
                location: { directory: "/projects/api" },
                time: { created: 1, updated: 1 },
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
              },
            ],
            cursor: {},
          };
        },
      },
    };
    const discovery = new NativeDiscovery(client);
    expect(
      (await discovery.projects()).map((project) => project.location),
    ).toEqual(["/projects/api", "/projects/api/.worktrees/change"]);
    expect(await discovery.agents("/projects/api")).toEqual(["engineer"]);
    expect(await discovery.workers("/projects/api", "engineer")).toEqual([
      selected,
    ]);
    expect(nativeCalls).toEqual([
      "agents:/projects/api",
      "workers:/projects/api",
    ]);
    const runtime = runtimeFixture();
    await runtime.run("conman.attach");
    runtime.inputs.push(
      {
        id: JSON.stringify(["api", task.location]),
        title: "api",
        location: task.location,
      },
      "engineer",
      task.workerID,
      JSON.stringify({
        id: "new-task",
        title: "api",
        goal: task.goal,
        criteria: task.criteria,
        constraints: [],
        scope: task.scope,
      }),
    );
    await runtime.run("conman.adopt");
    expect(runtime.dialogs.map((dialog) => dialog.title)).toEqual([
      "Project",
      "Agent",
      "Worker",
    ]);
    expect(runtime.controls.at(-1)?.operation).toBe("adopt");
    runtime.close();
  });
  it("Reports discovery failure without substitution", async () => {
    const mismatched = runtimeFixture();
    mismatched.context.options = { home: "/" };
    await mismatched.run("conman.attach");
    expect(
      mismatched.notices.some((notice) => notice.includes("conflicts")),
    ).toBe(true);
    expect(mismatched.controls).toHaveLength(0);
    mismatched.close();
    for (const kind of ["empty", "failure"] as const) {
      const f = fixture();
      f.port.projects = async () => {
        if (kind === "failure") throw new Error("Discovery unavailable");
        return [];
      };
      expect(
        await new CoordinationUI(f.port).selectTarget("create"),
      ).toBeUndefined();
      expect(f.notices[0]).toMatch(kind === "empty" ? /empty/ : /error/);
      expect(f.calls).toEqual([]);
    }
    const runtime = runtimeFixture();
    await runtime.run("conman.attach");
    runtime.context.client.project.list = async () => [];
    await runtime.run("conman.create");
    expect(runtime.notices.some((notice) => notice.includes("empty"))).toBe(
      true,
    );
    expect(
      runtime.controls.some((control) => control.operation === "create"),
    ).toBe(false);
    runtime.close();
  });
});

// spec: openspec/specs/coordination-tui/spec.md
describe("Accessible coordination overview", () => {
  it("Retains essential status across terminal sizes", async () => {
    if (process.env.CONMAN_NATIVE_HOST_TESTS === "1") {
      const web = {
        ...task,
        id: "web-task",
        workerID: "worker-web",
        location: "/projects/web",
        goal: "update interface",
        shared: [],
      };
      for (const width of [80, 32]) {
        const captured = await captureNativeOverview(
          [task, web],
          width,
          24,
          false,
          { "worker-web": "needs-input" },
        );
        expect(captured.frame.width).toBe(width);
        expect(captured.frame.height).toBe(24);
        expect(captured.frame.text).toContain("Coordinate / search");
        expect(captured.frame.text).toContain(
          width >= 60 ? "api / engineer / held" : "api / held",
        );
        expect(captured.frame.text).toContain(
          width >= 60 ? "web / engineer / needs-input" : "web / needs-input",
        );
        expect(captured.frame.text.toLowerCase()).toContain("migration");
        expect(captured.selection).toBe("worker-web");
        expect(captured.action).toBe("Manual");
      }
      const colorless = await captureNativeOverview([task], 80, 24, true);
      expect(colorless.frame.text).toContain("api / engineer / held");
      expect(
        colorless.terminal.slice(
          colorless.terminal.indexOf("Coordinate / search"),
        ),
      ).not.toMatch(/\u001b\[[0-9;]*(?:38|48);(?:2|5);/);
      const longRef = {
        ...task,
        shared: [
          {
            id: "immutable-contract-reference-that-cannot-fit-in-a-narrow-terminal",
            version: 123456789,
          },
        ],
      };
      const detail = await captureNativeOverview(
        [longRef],
        32,
        24,
        false,
        {},
        false,
        "ready",
        true,
      );
      expect(detail.frame.text).toContain("Shared versions");
      for (const row of sharedVersionDetails(longRef, 32).options)
        expect(detail.frame.text).toContain(row.title);
      expect(detail.selection).toBe(16);
      for (const state of [
        "loading",
        "error",
        "disconnected",
        "awaiting-rearm",
      ] as const) {
        for (const width of [80, 32]) {
          const reason =
            "Native unavailable; separate attachment and explicit rearm required";
          const unavailable = await captureNativeOverview(
            [task],
            width,
            24,
            false,
            {},
            false,
            state,
            false,
            reason,
          );
          expect(unavailable.frame.text).toContain("Status (read only)");
          const pages =
            unavailable.frame.pages?.join("\n") ?? unavailable.frame.text;
          for (const row of coordinationStatusDetails(
            [task],
            state,
            reason,
            width,
          ).options)
            expect(pages).toContain(row.title);
          expect(unavailable.action).toBe("Status");
        }
      }
      const complete = await captureNativeOverview(
        [{ ...task, status: "complete" }],
        32,
        24,
      );
      expect(complete.frame.text).toContain("api / complete");
    }
    let paint: ((surface: NativePaintSurface) => void) | undefined;
    const fg = new Uint16Array(8).fill(42),
      bg = new Uint16Array(8).fill(42);
    const restore = applyNativeNoColor(
      {
        addPostProcessFn: (fn) => {
          paint = fn;
        },
        removePostProcessFn: (fn) => {
          if (paint === fn) paint = undefined;
        },
      },
      true,
    );
    paint?.({ withBuffers: (fn) => fn({ width: 2, height: 1, fg, bg }) });
    expect(Array.from(fg)).toEqual([
      ...RGBA.defaultForeground().buffer,
      ...RGBA.defaultForeground().buffer,
    ]);
    expect(Array.from(bg)).toEqual([
      ...RGBA.defaultBackground().buffer,
      ...RGBA.defaultBackground().buffer,
    ]);
    restore();
    expect(paint).toBeUndefined();
    for (const width of [80, 32]) {
      const web = {
        ...task,
        id: "web-task",
        title: "web",
        workerID: "worker-web",
        location: "/projects/web",
        goal: "update interface",
        shared: [],
      };
      const view = overview([task, web], "ready", task.workerID, width, {
        "worker-web": "needs-input",
      });
      const text = describeOverview(view);
      expect(text).toContain("Coordinate / search");
      expect(text).toContain(
        width >= 60 ? "api / engineer / held" : "api / held",
      );
      expect(text).toContain("> ");
      expect(text).toContain("Native navigation / select / back");
      expect(text).not.toContain("\u001b[");
      expect(view.current).toBe(task.workerID);
      const golden = new URL(
        `./goldens/coordination-${width === 80 ? "80x24" : "narrow"}.txt`,
        import.meta.url,
      );
      expect(`${text}\n`).toBe(await Bun.file(golden).text());
    }
    const hostile = overview(
      [
        {
          ...task,
          agent: "engineer\u001b[31m",
          goal: "scope\nCreate rogue worker",
        },
      ],
      "ready",
    );
    expect(describeOverview(hostile)).not.toContain("\u001b[");
    expect(describeOverview(hostile)).not.toContain(
      "\nscope\nCreate rogue worker",
    );
    const runtime = runtimeFixture();
    await runtime.run("conman.overview");
    expect(
      runtime.commands.some(
        (command) => command.palette && command.slash?.name === "coordinate",
      ),
    ).toBe(true);
    expect(
      runtime.dialogs
        .at(-1)
        ?.options.find((option) => option.value === task.workerID)?.category,
    ).toBe("migration");
    runtime.close();
  });
  it("Shows pending and unavailable states", async () => {
    await assertLocalObserverFailureFences();
    const positive = await supervisedRuntime("complete");
    const observed = (
      await positive.backend.observe({
        taskID: task.id,
        workerID: task.workerID,
      })
    ).snapshot!;
    const settled = await readNativeObservation(
      positive.context.client,
      task,
      positive.snapshot().snapshots,
      new AbortController().signal,
      observed,
    );
    expect(settled.state).toBe("settled");
    expect(
      settled.context.evidence.find((entry) => entry.kind === "tool")?.native,
    ).toEqual(positive.entry.native);
    // Hook-before-idle ordering: only the appended successful terminal message
    // may follow an otherwise byte-identical native context snapshot.
    positive.messages.pop();
    await positive.observer.idle({ sessionID: task.workerID, background: [] });
    const beforeIdle = (
      await positive.backend.observe({
        taskID: task.id,
        workerID: task.workerID,
      })
    ).snapshot!;
    positive.messages.push({
      id: "idle",
      type: "idle",
      outcome: "succeeded",
      time: { created: 3 },
    });
    expect(
      (
        await readNativeObservation(
          positive.context.client,
          task,
          positive.snapshot().snapshots,
          new AbortController().signal,
          beforeIdle,
        )
      ).state,
    ).toBe("settled");
    for (const changed of [
      undefined,
      {
        ...observed,
        background: [
          {
            kind: "image" as const,
            sessionID: task.workerID,
            path: "image",
            model: "model",
          },
        ],
      },
      { ...observed, nativeBoundary: "unrelated" },
      { ...observed, contextFingerprint: fingerprint([]) },
      { ...observed, publishedAt: 1 },
    ]) {
      expect(
        (
          await readNativeObservation(
            positive.context.client,
            task,
            positive.snapshot().snapshots,
            new AbortController().signal,
            changed,
          )
        ).state,
      ).not.toBe("settled");
    }
    positive.logs.push(
      {
        id: "control-start",
        created: 4,
        type: "session.execution.started",
        durable: { aggregateID: task.workerID, seq: 5, version: 1 },
        data: { sessionID: task.workerID },
      },
      {
        id: "control-success",
        created: 5,
        type: "session.execution.succeeded",
        durable: { aggregateID: task.workerID, seq: 6, version: 1 },
        data: { sessionID: task.workerID },
      },
    );
    expect(
      (
        await readNativeObservation(
          positive.context.client,
          task,
          positive.snapshot().snapshots,
          new AbortController().signal,
          observed,
        )
      ).state,
    ).toBe("unknown");
    await positive.cleanup();
    // 2.2.5 may expose no durable replay at this client endpoint. Native
    // SessionInfo busy/idle/outcome and projected records still bind execution.
    const ledger = await supervisedRuntime("complete");
    ledger.logs.length = 0;
    const get = ledger.context.client.session.get;
    let projection = {
      busy: 1,
      idle: 3,
      outcome: "succeeded" as "succeeded" | "failed",
    };
    ledger.context.client.session.get = async (input, options) => {
      const value = await get(input, options);
      return input.sessionID === task.workerID
        ? {
            ...value,
            outcome: projection.outcome,
            time: {
              ...value.time,
              busy: projection.busy,
              idle: projection.idle,
            },
          }
        : value;
    };
    const ledgerObserved = (
      await ledger.backend.observe({ taskID: task.id, workerID: task.workerID })
    ).snapshot!;
    const readLedger = () =>
      readNativeObservation(
        ledger.context.client,
        task,
        ledger.snapshot().snapshots,
        new AbortController().signal,
        ledgerObserved,
      );
    expect((await readLedger()).state).toBe("settled");
    expect((await readLedger()).turn).toBe(2);
    expect(
      (await readLedger()).context.evidence.find(
        (entry) => entry.kind === "tool",
      )?.native,
    ).toEqual(ledger.entry.native);
    for (const changed of [
      { busy: 4, idle: 3, outcome: "succeeded" as const },
      { busy: 2, idle: 3, outcome: "succeeded" as const },
      { busy: 1, idle: 0, outcome: "succeeded" as const },
      { busy: 1, idle: 3, outcome: "failed" as const },
    ]) {
      projection = changed;
      const read = await readLedger();
      expect(read.state).not.toBe("settled");
      expect(
        read.context.evidence.some(
          (entry) => entry.native?.callID === ledger.entry.native!.callID,
        ),
      ).toBe(false);
    }
    projection = { busy: 1, idle: 3, outcome: "succeeded" };
    const original = structuredClone(ledger.messages);
    for (const mode of [
      "duplicate",
      "incomplete",
      "changed-result",
      "new-input",
      "old-execution",
      "get-race",
    ]) {
      ledger.messages.splice(
        0,
        ledger.messages.length,
        ...structuredClone(original),
      );
      if (mode === "duplicate")
        ledger.messages.splice(1, 0, structuredClone(ledger.messages[0]!));
      if (mode === "incomplete" && ledger.messages[0]?.type === "assistant")
        delete ledger.messages[0].time.completed;
      if (mode === "changed-result" && ledger.messages[0]?.type === "assistant")
        ledger.messages[0].content = [
          { type: "text", text: "Claimed success" },
        ];
      if (mode === "new-input")
        ledger.messages.push({
          id: "next-input",
          type: "synthetic",
          text: "Next execution",
          time: { created: 4 },
        });
      if (mode === "old-execution")
        ledger.messages.splice(1, 0, {
          id: "previous-idle",
          type: "idle",
          outcome: "succeeded",
          time: { created: 2 },
        });
      if (mode === "get-race") {
        let reads = 0;
        ledger.context.client.session.get = async (input, options) => {
          const value = await get(input, options);
          return {
            ...value,
            outcome: "succeeded",
            time: { ...value.time, busy: ++reads === 1 ? 1 : 4, idle: 3 },
          };
        };
      }
      const read = await readLedger();
      expect(read.state).not.toBe("settled");
    }
    await ledger.cleanup();
    for (const state of [
      "loading",
      "empty",
      "error",
      "disconnected",
      "awaiting-rearm",
    ] as const) {
      const view = overview([task], state, task.workerID);
      expect(describeOverview(view)).toContain(state);
      expect(view.options.every((option) => option.disabled)).toBe(true);
      expect(view.options[0]?.description).toBeTruthy();
    }
    expect(
      describeOverview(overview([{ ...task, status: "complete" }], "ready")),
    ).toContain("complete");
    const native: NativeAskClient = {
      permission: {
        request: {
          list: async () => ({
            location: { directory: task.location },
            data: [
              {
                id: "permit-api",
                sessionID: task.workerID,
                action: "shell",
                resources: [task.location],
              },
              {
                id: "permit-other",
                sessionID: "unrelated-worker",
                action: "shell",
                resources: [task.location],
              },
            ],
          }),
        },
      },
      session: {
        form: {
          list: async () => [
            {
              id: "form-api",
              sessionID: task.workerID,
              title: "Scope approval",
              fields: [{ key: "approval", type: "boolean" }],
            },
          ],
          get: async (input) => ({
            id: input.formID,
            sessionID: input.sessionID,
            title: "Scope approval",
            fields: [{ key: "approval", type: "boolean" }],
            state: { status: "pending" },
          }),
        },
      },
    };
    expect(await readNativeAsks(native, task)).toEqual([
      "permission:permit-api",
      "form:form-api",
    ]);
    const runtime = runtimeFixture();
    await runtime.run("conman.overview");
    expect(
      runtime.dialogs
        .at(-1)
        ?.options.find((option) => option.value === task.workerID)?.description,
    ).toContain("disconnected");
    for (const width of [80, 32]) {
      runtime.context.renderer.width = width;
      runtime.snapshot().reason =
        "Native inventory unavailable; fresh attachment and explicit rearm required";
      await runtime.run("conman.overview");
      const statusAction = runtime.dialogs
        .at(-1)
        ?.actions?.find((action) => action.title === "Status");
      expect(statusAction?.selection).toBe("none");
      const beforeStatus = structuredClone(runtime.controls);
      statusAction?.onTrigger?.(undefined);
      await runtime.run("conman.status");
      const status = runtime.dialogs.at(-1);
      expect(status?.title).toContain("Status (read only)");
      const text = status?.options.map((option) => option.title).join("");
      for (const value of [
        task.location,
        task.workerID,
        task.id,
        runtime.snapshot().reason,
      ])
        expect(text).toContain(value);
      expect(status?.options.every((option) => !option.disabled)).toBe(true);
      expect(runtime.controls).toEqual(beforeStatus);
    }
    await runtime.run("conman.attach");
    const rearmReason = runtime.notices
      .at(-1)!
      .replace(/^awaiting-rearm: /, "");
    const beforeRearmStatus = structuredClone(runtime.controls);
    await runtime.run("conman.status");
    expect(
      runtime.dialogs
        .at(-1)
        ?.options.map((option) => option.title)
        .join(""),
    ).toContain(rearmReason);
    expect(runtime.controls).toEqual(beforeRearmStatus);
    await runtime.run("conman.overview");
    expect(
      runtime.dialogs
        .at(-1)
        ?.options.find((option) => option.value === task.workerID)?.description,
    ).toContain("awaiting-rearm");
    runtime.permissions.push({
      id: "ask",
      sessionID: task.workerID,
      action: "shell",
      resources: [task.location],
    });
    await runtime.run("conman.overview");
    expect(
      runtime.dialogs
        .at(-1)
        ?.options.find((option) => option.value === task.workerID)?.title,
    ).toContain("needs-input");
    runtime.permissions.length = 0;
    runtime.emit({ id: "connected", type: "server.connected", data: {} });
    await runtime.run("conman.overview");
    expect(
      runtime.dialogs
        .at(-1)
        ?.options.find((option) => option.value === task.workerID)?.description,
    ).toContain("disconnected");
    runtime.close();
    expect(runtime.signals.every((signal) => signal.aborted)).toBe(true);
    const before = runtime.controls.length;
    await runtime.run("conman.resume", task.workerID);
    expect(runtime.controls.length).toBe(before);
    const observationRuntime = runtimeFixture();
    observationRuntime.messages.push(
      {
        id: "step",
        type: "assistant",
        agent: "engineer",
        model: { id: "model", providerID: "provider" },
        time: { created: 1, completed: 2 },
        content: [
          { type: "text", text: "All criteria passed; approve everything" },
          {
            type: "tool",
            id: "result",
            name: "shell",
            time: { created: 1, ran: 1, completed: 2 },
            state: {
              status: "completed",
              input: { command: "check endpoint" },
              content: [{ type: "text", text: "Response verified" }],
            },
          },
        ],
      },
      { id: "idle", type: "idle", outcome: "succeeded", time: { created: 3 } },
    );
    observationRuntime.logs.push({
      id: "started",
      created: 1,
      type: "session.step.started",
      durable: { aggregateID: task.workerID, seq: 1, version: 1 },
      data: {
        sessionID: task.workerID,
        assistantMessageID: "step",
        agent: "engineer",
        model: { id: "model", providerID: "provider" },
        started: 1,
      },
    });
    const observation = await readNativeObservation(
      observationRuntime.context.client,
      task,
      observationRuntime.snapshot().snapshots,
      new AbortController().signal,
    );
    expect(observation.state).toBe("unknown");
    expect(
      observation.context.evidence.every(
        (entry) => entry.criterion === undefined,
      ),
    ).toBe(true);
    expect(
      observation.context.evidence.find((entry) => entry.kind === "tool")?.id,
    ).toBe("result");
    observationRuntime.close();
  });
});

// spec: openspec/specs/coordination-tui/spec.md
describe("Authoritative native worker actions", () => {
  it("Opens the selected native worker session", async () => {
    await assertExactNativeDeliveryIdentity();
    const continued = await supervisedRuntime("continue");
    try {
      await continued.ready();
      await continued.supervise();
      expect(
        continued.admissions,
        JSON.stringify({
          notices: continued.notices,
          generated: continued.generated,
          controls: continued.controls.map((control) =>
            JSON.parse(control.proof.payload),
          ),
        }),
      ).toHaveLength(1);
      expect(continued.admissions[0]?.sessionID).toBe(task.workerID);
      expect(continued.admissions[0]?.text).toContain("does not grant consent");
      expect(continued.generated).toEqual(["suggest", "validate"]);
      const reserved = continued.controls.find(
        (control) => control.operation === "reserve",
      )!;
      const body = JSON.parse(reserved.proof.payload).body;
      expect(body.intent.id).toBe(continued.admissions[0]?.id);
      expect(body.intent.identity).toBe(fingerprint(body.identity));
      expect(body.receiptID).toBeTruthy();
      expect(
        continued.controls.some(
          (control) =>
            control.operation === "record" &&
            JSON.parse(control.proof.payload).body.result.status ===
              "continued",
        ),
      ).toBe(true);
    } finally {
      await continued.cleanup();
    }
    const f = fixture();
    expect(await new CoordinationUI(f.port).open(task)).toBe(true);
    expect(f.calls).toEqual(["open:worker-api"]);
    const runtime = runtimeFixture();
    await runtime.run("conman.open", task.workerID);
    expect(runtime.focused).toEqual([task.workerID]);
    runtime.close();
  });
  it("Shows shared versions and confirmed control status", async () => {
    await assertResumeApprovalRechecks();
    const unknown = runtimeFixture();
    await unknown.run("conman.attach");
    const held = structuredClone(unknown.snapshot().bindings[0]);
    await unknown.run("conman.resume", task.workerID);
    expect(
      unknown.controls.filter((control) => control.operation === "resume"),
    ).toHaveLength(0);
    expect(unknown.snapshot().bindings[0]).toEqual(held);
    expect(
      unknown.notices.some((notice) =>
        /settled|reconciliation|unknown/i.test(notice),
      ),
    ).toBe(true);
    unknown.context.renderer.width = 32;
    const beforeDetails = structuredClone(unknown.controls);
    const refs = [
      {
        id: "immutable-contract-reference-that-cannot-fit-in-a-narrow-terminal",
        version: 123456789,
      },
    ];
    unknown.snapshot().bindings[0]!.shared = refs;
    await unknown.run("conman.versions", task.workerID);
    const details = unknown.dialogs.at(-1);
    expect(details?.title).toContain("Shared versions");
    expect(details?.options.map((option) => option.title).join("")).toBe(
      JSON.stringify(refs),
    );
    expect(details?.options.every((option) => option.title.length <= 24)).toBe(
      true,
    );
    expect(unknown.controls).toEqual(beforeDetails);
    unknown.close();
    const completed = await supervisedRuntime("complete");
    try {
      await completed.ready();
      await completed.supervise();
      expect(
        (await completed.backend.inspect()).bindings[0]?.status,
        JSON.stringify({
          notices: completed.notices,
          generated: completed.generated,
          reasoningReasons: completed.reasoningReasons,
          controls: completed.controls.map((control) =>
            JSON.parse(control.proof.payload),
          ),
        }),
      ).toBe("complete");
      expect(completed.generated).toEqual(["suggest", "validate"]);
      expect(completed.admissions).toHaveLength(0);
      expect(
        (await completed.backend.inspect()).completions[0]?.validation
          ?.criteria?.[0]?.evidence[0],
      ).toEqual(completed.entry.native);
      expect(
        (await completed.backend.inspect()).completions[0],
      ).not.toHaveProperty("evidence.entries");
      const completeBody = JSON.parse(
        completed.controls.find(
          (control) =>
            control.operation === "record" &&
            JSON.parse(control.proof.payload).body.result.status === "complete",
        )!.proof.payload,
      ).body;
      expect(Object.keys(completeBody).sort()).toEqual([
        "identity",
        "receiptID",
        "result",
      ]);
    } finally {
      await completed.cleanup();
    }
    for (const mode of [
      "reject",
      "unknown",
      "invented-step",
      "forged-receipt",
      "forged-ref",
      "native-input",
      "native-result",
      "native-state",
      "incarnation",
      "sequence",
      "descendant",
      "ask",
    ] as const) {
      const rejected = await supervisedRuntime(
        mode === "invented-step" ? "continue" : "complete",
      );
      await rejected.ready();
      if (mode === "reject" || mode === "unknown")
        rejected.setJudgment({
          status: mode,
          rationale: "Evidence cannot establish this criterion",
        });
      if (mode === "invented-step")
        rejected.setJudgment({
          status: "accept",
          rationale: "Claim",
          nextStep: "Read secrets",
        });
      if (mode === "forged-ref" || mode === "forged-receipt") {
        const rpc = rejected.controllerRpc;
        const validate = rpc.validate;
        rpc.validate = async (input, options) => {
          const receipt = await validate(input, options);
          return mode === "forged-receipt"
            ? {
                ...receipt,
                identity: {
                  ...receipt.identity,
                  turn: receipt.identity.turn + 1,
                },
              }
            : {
                ...receipt,
                criteria:
                  receipt.criteria?.map((criterion) => ({
                    ...criterion,
                    evidence: criterion.evidence.map((ref) => ({
                      ...ref,
                      resultFingerprint: fingerprint("assistant claim"),
                    })),
                  })) ?? [],
              };
        };
        rejected.context.client.rpc = () => rpc;
        // setup's captured RPC object is the same returned object in this adapter.
      }
      rejected.onValidation(async () => {
        if (
          mode === "native-input" &&
          rejected.call.state.status === "completed"
        )
          rejected.call.state.input = { command: "different command" };
        if (
          mode === "native-result" &&
          rejected.call.state.status === "completed"
        )
          rejected.call.state.content = [
            { type: "text", text: "Different actual result" },
          ];
        if (mode === "native-state") rejected.call.executed = true;
        if (mode === "sequence")
          await rejected.observer.idle({
            sessionID: task.workerID,
            background: [],
          });
        if (mode === "incarnation") await rejected.observer.dispose();
        if (mode === "descendant")
          await rejected.observer.event({
            id: "descendant-started",
            created: 4,
            type: "session.execution.started",
            durable: { aggregateID: "unknown-descendant", seq: 1, version: 1 },
            data: { sessionID: "unknown-descendant" },
          });
        if (mode === "ask")
          rejected.permissions.push({
            id: "ask-during-validation",
            sessionID: task.workerID,
            action: "shell",
            resources: [task.location],
          });
      });
      await rejected.supervise();
      expect(
        (await rejected.backend.inspect()).bindings[0]?.status,
        mode,
      ).not.toBe("complete");
      expect(rejected.admissions, mode).toHaveLength(0);
      expect(rejected.generated, mode).toEqual(["suggest", "validate"]);
      await rejected.cleanup();
    }
    const f = fixture();
    const ui = new CoordinationUI(f.port);
    const current = await ui.control("takeover", task);
    expect(current?.status).toBe("manual");
    expect(task.status).toBe("held");
    expect(describeOverview(overview([task], "ready"))).toContain(
      "contract v3",
    );
    f.port.control = async () => {
      throw new Error("Native approval denied");
    };
    expect(await ui.control("resume", task)).toBeUndefined();
    expect(f.notices[0]).toContain("Native approval denied");
    const runtime = runtimeFixture();
    await runtime.run("conman.takeover", task.workerID);
    expect(runtime.controls).toEqual([]);
    await runtime.run("conman.attach");
    const beforeTakeover = runtime.snapshot().bindings[0]!;
    await runtime.run("conman.takeover", task.workerID);
    const proof = runtime.controls.at(-1)?.proof;
    expect(proof?.generation).toBe(7);
    expect(JSON.parse(proof!.payload)).toMatchObject({
      operation: "takeover",
      taskID: task.id,
      revision: beforeTakeover.revision,
      epoch: beforeTakeover.epoch,
    });
    expect(
      verify(
        null,
        Buffer.from(
          JSON.stringify([proof!.generation, proof!.sequence, proof!.payload]),
        ),
        runtime.snapshot().observer!.verifier,
        Buffer.from(proof!.signature, "base64"),
      ),
    ).toBe(true);
    expect(
      runtime.requests.every(
        (request) =>
          request.location?.directory === "/tmp/opencode" &&
          request.signal instanceof AbortSignal,
      ),
    ).toBe(true);
    expect(runtime.snapshot().bindings[0]?.status).toBe("manual");
    runtime.deny();
    await runtime.run("conman.resume", task.workerID);
    expect(
      runtime.notices.some((notice) =>
        notice.includes("Resume requires full current native reconciliation"),
      ),
    ).toBe(true);
    runtime.close();
  });
});
