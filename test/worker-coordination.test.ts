import { describe, expect, it, spyOn } from "bun:test";
import { BackseatRpc } from "../src/rpc.ts";
import { COORDINATOR_TOOL_IDS } from "../src/tools.ts";
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
  ObserverAuthority,
  createFilesystemOwnershipPort,
  createObserverCapability,
  forceNativeAsk,
  type LockInspection,
  type ObserverRecord,
  type SignedControl,
  type OwnershipPort,
} from "../src/ownership.ts";
import nativePlugin, {
  createNativeBackend,
  createWorkerObserver,
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
        attach(
          input: { coordinatorID: string; verifier: string },
          context: { signal: AbortSignal },
        ): Promise<{
          generation: number;
          dataDir: string;
          coordinatorLocation: string;
        }>;
        inspect(input: {
          proof: SignedControl;
        }): Promise<import("../src/rpc.ts").CoordinatorSnapshot>;
        recover(
          input: { coordinatorID: string },
          context: { signal: AbortSignal },
        ): Promise<import("../src/rpc.ts").CoordinatorBootstrap>;
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
    async invoke(tool: string, input: unknown = {}) {
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
        signal: new AbortController().signal,
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
      for (const tool of [
        "execute",
        "backseat_list_sessions",
        "backseat_dispatch_task",
        "question",
      ])
        await f.execute(tool);
      expect(f.dispatched).toEqual([
        "execute",
        "backseat_list_sessions",
        "backseat_dispatch_task",
        "question",
      ]);
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
      for (const tool of [
        "execute",
        "backseat_list_sessions",
        "backseat_delete_session",
        "question",
      ])
        expect(effect(tool)).toBe("allow");
      for (const action of [
        "backseat.attach",
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
          fixture.backend.attach({
            coordinatorID: "coordinator",
            verifier: createObserverCapability().verifier,
          }),
        ).rejects.toThrow("Backseat Coordinator");
        expect(fixture.asks).toHaveLength(before);
      } finally {
        await fixture.backend.dispose();
      }
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
) {
  const home = "/projects/home";
  let root: unknown = {
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
  const capability = createObserverCapability();
  const { generation } = attach
    ? await backend.attach({
        coordinatorID: "coordinator",
        verifier: capability.verifier,
      })
    : { generation: 0 };
  let sequence = 0;
  const control = async (
    operation: "create" | "adopt" | "hold" | "resume" | "share",
    taskID: string,
    body: unknown,
  ) => {
    const b = (await backend.inspect()).bindings.find((b) => b.id === taskID);
    return backend.control({
      operation,
      taskID,
      proof: capability.sign(
        generation,
        ++sequence,
        {
          operation,
          taskID,
          revision: b?.revision ?? 0,
          epoch: b?.epoch ?? 0,
          body,
        },
        observerScope,
      ),
    });
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
      const capability = createObserverCapability();
      const attached = await f.backend.attach({
        coordinatorID: "coordinator",
        verifier: capability.verifier,
      });
      expect(attached).toMatchObject(observerScope);
      f.failWrite();
      await expect(
        f.backend.read(
          capability.sign(
            attached.generation,
            1,
            {
              operation: "inspect",
              taskID: "coordinator",
              revision: 0,
              epoch: 0,
            },
            attached,
          ),
        ),
      ).rejects.toThrow("Storage failed");
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
    for (const change of ["location", "role"] as const) {
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
        let changed = false;
        f.host.session.get = async (input) => ({
          ...(await get(input)),
          ...(changed && input.sessionID === "coordinator"
            ? change === "location"
              ? { location: { directory: "/projects/relocated" } }
              : { agent: "engineer" }
            : {}),
        });
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>((done) => {
          entered = done;
        });
        const wait = new Promise<void>((done) => {
          release = done;
        });
        const { get: read, set } = f.host.storage;
        let writes = 0;
        f.host.storage = {
          get: read,
          set: async (key, value) => {
            if (++writes === 2) {
              entered();
              await wait;
            }
            await set(key, value);
          },
        };
        const pending = f.control("hold", goal.id, {});
        await ready;
        changed = true;
        release();
        const result = await pending;
        expect(result.accepted).toBe(true);
        expect(result.snapshot).toBeUndefined();
        expect(result.reason).toMatch(/committed.*do not retry/i);
        expect((await f.backend.inspect()).bindings[0]!.epoch).toBe(2);
      } finally {
        await f.backend.dispose();
      }
    }
    const disclosures: string[] = [];
    for (const window of [
      "proof-publication",
      "observation-read",
      "final-catalog",
    ] as const) {
      const paused = await backendFixture([
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
        const getSession = paused.host.session.get;
        let directory = observerScope.coordinatorLocation;
        paused.host.session.get = async (input) => ({
          ...(await getSession(input)),
          ...(input.sessionID === "coordinator"
            ? { location: { directory } }
            : {}),
        });
        const listAgents = paused.host.agent.list;
        paused.host.agent.list = async (input) => ({
          ...(await listAgents(input)),
          location: { directory: input?.location?.directory ?? directory },
        });
        const entry = (await paused.backend.inspect()).bindings[0]!;
        paused.observation(entry);
        const capability = createObserverCapability();
        const { generation } = await paused.backend.attach({
          coordinatorID: "coordinator",
          verifier: capability.verifier,
        });
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>((done) => {
          entered = done;
        });
        const wait = new Promise<void>((done) => {
          release = done;
        });
        const catalog = paused.host.agent.list;
        let catalogs = 0;
        paused.host.agent.list = async (input) => {
          const result = await catalog(input);
          if (window === "final-catalog" && ++catalogs === 2) {
            entered();
            await wait;
          }
          return result;
        };
        const { get, set } = paused.host.storage;
        paused.host.storage = {
          get: async (key) => {
            if (window === "observation-read" && key.endsWith(":snapshot")) {
              entered();
              await wait;
            }
            return get(key);
          },
          set: async (key, value) => {
            if (window === "proof-publication") {
              entered();
              await wait;
            }
            return set(key, value);
          },
        };
        const operation =
          window === "proof-publication" ? "inspect" : "observe";
        const proof = capability.sign(
          generation,
          1,
          {
            operation,
            taskID: operation === "inspect" ? "coordinator" : entry.id,
            revision: operation === "inspect" ? 0 : entry.revision,
            epoch: operation === "inspect" ? 0 : entry.epoch,
            ...(operation === "observe"
              ? { body: { workerID: entry.workerID } }
              : {}),
          },
          observerScope,
        );
        const pending =
          operation === "inspect"
            ? paused.backend.read(proof)
            : paused.backend.readObservation(
                { taskID: entry.id, workerID: entry.workerID },
                proof,
              );
        await ready;
        directory = "/projects/relocated-before-disclosure";
        release();
        disclosures.push(
          await pending.then(
            () => `${window}:disclosed`,
            (error) =>
              `${window}:${/Observer authority|Coordinator identity changed/.test(String(error)) ? "held" : String(error)}`,
          ),
        );
      } finally {
        await paused.backend.dispose();
      }
    }
    expect(disclosures).toEqual([
      "proof-publication:held",
      "observation-read:held",
      "final-catalog:held",
    ]);
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
    const capability = createObserverCapability();
    try {
      const { generation } = await f.backend.attach({
        coordinatorID: "coordinator",
        verifier: capability.verifier,
      });
      const read = capability.sign(
        generation,
        1,
        { operation: "inspect", taskID: "coordinator", revision: 0, epoch: 0 },
        observerScope,
      );
      for (const change of [
        { dataDir: "/different-store" },
        { coordinatorLocation: "/different-conversation" },
      ]) {
        await expect(f.backend.read({ ...read, ...change })).rejects.toThrow(
          "Observer authority",
        );
        await expect(
          f.backend.read(
            capability.sign(
              generation,
              1,
              {
                operation: "inspect",
                taskID: "coordinator",
                revision: 0,
                epoch: 0,
              },
              { ...observerScope, ...change },
            ),
          ),
        ).rejects.toThrow("Observer authority");
      }
      await expect(
        f.backend.read({
          ...read,
          signature: createObserverCapability().sign(
            generation,
            1,
            {
              operation: "inspect",
              taskID: "coordinator",
              revision: 0,
              epoch: 0,
            },
            observerScope,
          ).signature,
        }),
      ).rejects.toThrow("Observer authority");
      expect((await f.backend.read(read)).bindings[0]?.followups).toBe(2);
      await expect(f.backend.read(read)).rejects.toThrow("Observer authority");
      const task = (await f.backend.inspect()).bindings[0]!;
      f.observation(task);
      const observation = capability.sign(
        generation,
        2,
        {
          operation: "observe",
          taskID: task.id,
          revision: task.revision,
          epoch: task.epoch,
          body: { workerID: task.workerID },
        },
        observerScope,
      );
      await expect(
        f.backend.readObservation(
          { taskID: task.id, workerID: "different-worker" },
          observation,
        ),
      ).rejects.toThrow("Mismatched observation");
      const current = capability.sign(
        generation,
        3,
        {
          operation: "observe",
          taskID: task.id,
          revision: task.revision,
          epoch: task.epoch,
          body: { workerID: task.workerID },
        },
        observerScope,
      );
      expect(
        (
          await f.backend.readObservation(
            { taskID: task.id, workerID: task.workerID },
            current,
          )
        ).snapshot?.sessionID,
      ).toBe(task.workerID);
      await f.backend.attach({
        coordinatorID: "coordinator",
        verifier: createObserverCapability().verifier,
      });
      await expect(
        f.backend.read(
          capability.sign(
            generation,
            4,
            {
              operation: "inspect",
              taskID: "coordinator",
              revision: 0,
              epoch: 0,
            },
            observerScope,
          ),
        ),
      ).rejects.toThrow("Observer authority");
    } finally {
      await f.backend.dispose();
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
          expect((await f.backend.inspect()).observer?.sequence).toBe(1);
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
          import nativePlugin from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
          import * as ownership from ${JSON.stringify(new URL("../src/ownership.ts", import.meta.url).href)};
          const directory=${JSON.stringify(directory)};
          let finish, failing=false, unhandled=0, releases=0;
          const ended=new Promise(resolve=>{finish=resolve;});
          const values=new Map();
          const registration={dispose:async()=>{}};
          const core={projects:new Map(),backend:{bootstrap:()=>({dataDir:directory,authority:"owned"}),fenceProject:async()=>{}},storage:{get:async key=>values.get(key),set:async(key,value)=>{if(failing)throw new Error("Injected observer invalidation failure");values.set(key,value);}},dispose:async()=>{}};
          const acquisition=spyOn(ownership,"acquireCoordinatorCore").mockResolvedValue({core,release:async()=>{releases++;}});
          process.on("unhandledRejection",()=>{unhandled++;});
          const close=await nativePlugin.setup({app:{version:"2.2.5"},options:{dataDir:directory},location:{directory},session:{hook:async()=>registration},event:{async *subscribe(){await ended;}},permission:{hook:async()=>registration},agent:{transform:async()=>registration},rpc:{register:async()=>registration},tool:{transform:async()=>registration,hook:async()=>registration}});
          failing=true;finish();
          await new Promise(resolve=>setImmediate(resolve));
          await new Promise(resolve=>setImmediate(resolve));
          let held=false;try{await close();}catch{held=true;}
          acquisition.mockRestore();
          process.stdout.write(JSON.stringify({unhandled,releases,held}));
        `);
        expect(JSON.parse(output)).toEqual({
          unhandled: 0,
          releases: 0,
          held: true,
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
        finish();
        const capability = createObserverCapability();
        const attached = await project.rpc.attach(
          {
            coordinatorID: project.coordinatorID,
            verifier: capability.verifier,
          },
          { signal: new AbortController().signal },
        );
        await project.rpc.inspect({
          proof: capability.sign(
            attached.generation,
            1,
            {
              operation: "inspect",
              taskID: project.coordinatorID,
              revision: 0,
              epoch: 0,
            },
            attached,
          ),
        });
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
        const signal = new AbortController().signal;
        await first.rpc.recover(
          { coordinatorID: first.coordinatorID },
          { signal },
        );
        const attaching = first.rpc
          .attach(
            {
              coordinatorID: first.coordinatorID,
              verifier: createObserverCapability().verifier,
            },
            { signal },
          )
          .catch(() => undefined);
        await entered;
        const closing =
          startup === "unload" ? first.close() : Promise.resolve();
        finish();
        const [, attached] = await Promise.all([closing, attaching]);
        if (startup === "unload")
          expect(first.disposedHooks).toContain("experimental.idle");
        else {
          expect(attached?.generation).toBeDefined();
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
      const capability = createObserverCapability();
      const attachment = project.rpc
        .attach(
          {
            coordinatorID: project.coordinatorID,
            verifier: capability.verifier,
          },
          { signal: new AbortController().signal },
        )
        .then(
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
        const capability = createObserverCapability();
        const signal = new AbortController().signal;
        const initial = await first.rpc.attach(
          { coordinatorID: first.coordinatorID, verifier: capability.verifier },
          { signal },
        );
        const replacement = await second.rpc.attach(
          {
            coordinatorID: second.coordinatorID,
            verifier: capability.verifier,
          },
          { signal },
        );
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
        const departedRead = first.rpc
          .inspect({
            proof: capability.sign(
              replacement.generation,
              1,
              {
                operation: "inspect",
                taskID: second.coordinatorID,
                revision: 0,
                epoch: 0,
              },
              replacement,
            ),
          })
          .then(
            () => "disclosed",
            () => "withheld",
          );
        await ready;
        const unloading = first.close();
        firstClosed = true;
        release();
        expect(await departedRead).toBe("withheld");
        await unloading;
        const snapshot = await second.rpc.inspect({
          proof: capability.sign(
            replacement.generation,
            2,
            {
              operation: "inspect",
              taskID: second.coordinatorID,
              revision: 0,
              epoch: 0,
            },
            replacement,
          ),
        });
        expect(snapshot.observer?.coordinatorID).toBe(second.coordinatorID);
        expect(snapshot.observer?.sequence).toBe(2);
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
        await project.rpc
          .recover(
            { coordinatorID: project.coordinatorID },
            { signal: request.signal },
          )
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
        const signal = new AbortController().signal;
        expect((await project.rpc.bootstrap()).authority).toBe("held");
        expect(
          await project.rpc.recover(
            { coordinatorID: project.coordinatorID },
            { signal },
          ),
        ).toEqual({
          dataDir: directory,
          authority: "held",
          reason: "Recovery approved; separate attachment/rearm required",
        });
        expect(approvals).toBe(1);
        expect(
          await readFile(`${directory}/state.json`, "utf8").catch(
            () => undefined,
          ),
        ).toBeUndefined();
        const capability = createObserverCapability();
        const attached = await project.rpc.attach(
          {
            coordinatorID: project.coordinatorID,
            verifier: capability.verifier,
          },
          { signal },
        );
        expect(approvals).toBe(2);
        const snapshot = await project.rpc.inspect({
          proof: capability.sign(
            attached.generation,
            1,
            {
              operation: "inspect",
              taskID: project.coordinatorID,
              revision: 0,
              epoch: 0,
            },
            attached,
          ),
        });
        expect(snapshot.bindings).toEqual([]);
        expect(await readFile(`${directory}/state.json`, "utf8")).toContain(
          "observer",
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
  it("Rejects child adoption and takeover before and after approval", async () => {
    for (const operation of ["adopt", "takeover"] as const) {
      for (const phase of ["before", "during"] as const) {
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
        let parentID: string | undefined =
          phase === "before" ? "native-parent" : undefined;
        const get = f.host.session.get;
        f.host.session.get = async (input) => ({
          ...(await get(input)),
          ...(input.sessionID === selected.workerID && parentID
            ? { parentID }
            : {}),
        });
        f.approve(async () => {
          parentID = "native-parent";
        });
        try {
          await expect(
            f.backend.nativeControl(
              operation,
              selected.id,
              operation === "adopt"
                ? { goal, workerID: selected.workerID }
                : {},
              {
                sessionID: "coordinator",
                agent: coordinatorAgent.id,
                messageID: "message",
                id: "ownership-call",
              },
            ),
          ).rejects.toThrow("top-level");
          expect(f.effects).toEqual([]);
          const current = (await f.backend.inspect()).bindings;
          expect(current).toEqual(operation === "adopt" ? [] : [selected]);
          expect(f.asks).toHaveLength(phase === "before" ? 0 : 1);
        } finally {
          await f.backend.dispose();
        }
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
      await f.backend.attach({
        coordinatorID: "coordinator",
        verifier: createObserverCapability().verifier,
      });
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
  });

  it("Rejects changed or unapproved manual targets", async () => {
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
  });

  it("Retains an uncertain manual send without resending", async () => {
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
      "bare",
      "exhausted",
      "unresolved",
      "pending",
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
        if (problem === "pending")
          body.reconciliation.asks.push("human" as never);
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
          await expect(
            f.control("resume", current.id, problem === "bare" ? {} : body),
          ).rejects.toThrow();
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
            generation: (await projected.backend.inspect()).observer!
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
  const capability = createObserverCapability();
  const proof = capability.sign(
    1,
    1,
    {
      operation: "hold",
      taskID: "api-task",
      revision: 1,
      epoch: 1,
      body: {},
    },
    observerScope,
  );
  const valid = { operation: "hold" as const, taskID: "api-task", proof };
  const parse = BackseatRpc.methods.control.input["~standard"].validate;
  expect(parse(valid)).toEqual({ value: valid });
  for (const invalid of [
    { ...valid, confirmed: true },
    { ...valid, operation: "override" },
    { ...valid, taskID: "" },
    { ...valid, proof: undefined },
    { ...valid, proof: { ...proof, generation: 0 } },
    { ...valid, proof: { ...proof, sequence: 1.5 } },
    { ...valid, proof: { ...proof, payload: [] } },
    { ...valid, proof: { ...proof, signature: "" } },
    { ...valid, proof: { ...proof, confirmed: true } },
  ])
    expect(parse(invalid)).toHaveProperty("issues");
  const attach = {
    coordinatorID: "coordinator",
    verifier: capability.verifier,
  };
  expect(
    BackseatRpc.methods.attach.input["~standard"].validate(attach),
  ).toEqual({
    value: attach,
  });
  expect(
    BackseatRpc.methods.attach.input["~standard"].validate({
      ...attach,
      confirmed: true,
    }),
  ).toHaveProperty("issues");
  const snapshot = {
    version: 1 as const,
    dataDir: "/projects/coordinator",
    authority: "owned" as const,
    bindings: [],
    snapshots: [],
    intents: [],
    completions: [],
  };
  expect(
    BackseatRpc.methods.control.output["~standard"].validate({
      accepted: true,
      snapshot,
    }),
  ).toEqual({ value: { accepted: true, snapshot } });
  const reason = "Control committed; inventory withheld; do not retry";
  expect(
    BackseatRpc.methods.control.output["~standard"].validate({
      accepted: true,
      reason,
    }),
  ).toEqual({ value: { accepted: true, reason } });
  for (const reply of [
    { accepted: false, reason },
    { accepted: true },
    { accepted: true, reason, extra: true },
  ]) {
    expect(
      BackseatRpc.methods.control.output["~standard"].validate(reply),
    ).toHaveProperty("issues");
  }
  expect(
    BackseatRpc.methods.control.output["~standard"].validate({
      accepted: "yes",
      snapshot,
    }),
  ).toHaveProperty("issues");
}

// spec: openspec/specs/worker-coordination/spec.md
describe("Approved observer generation", () => {
  function observerPort() {
    let record: ObserverRecord | undefined;
    const approvals: ObserverRecord[] = [];
    return {
      approvals,
      port: {
        async load() {
          return record && structuredClone(record);
        },
        async save(value: ObserverRecord) {
          record = structuredClone(value);
        },
        async approve(value: ObserverRecord) {
          approvals.push(structuredClone(value));
        },
      },
    };
  }

  it("Native approval binds observer generation", async () => {
    for (const field of ["projectID", "workspaceID"] as const) {
      const current = await backendFixture();
      try {
        let changed = false;
        const get = current.host.session.get;
        current.host.session.get = async (input) => {
          const session = await get(input);
          return input.sessionID === "coordinator"
            ? {
                ...session,
                ...(field === "projectID"
                  ? { projectID: changed ? "after" : "before" }
                  : {}),
                location: {
                  ...session.location,
                  ...(field === "workspaceID"
                    ? { workspaceID: changed ? "after" : "before" }
                    : {}),
                },
              }
            : session;
        };
        current.approve(async () => {
          changed = true;
        });
        await expect(
          current.backend.attach({
            coordinatorID: "coordinator",
            verifier: createObserverCapability().verifier,
          }),
        ).rejects.toThrow("changed during native approval");
      } finally {
        await current.backend.dispose();
      }
    }
    const unloading = await backendFixture();
    try {
      const abort = new AbortController();
      unloading.host.projectSignal = () => abort.signal;
      const list = unloading.host.agent.list;
      let approved = false;
      unloading.approve(async () => {
        approved = true;
      });
      unloading.host.agent.list = async (input) => {
        const result = await list(input);
        if (approved && input?.location?.directory === goal.location)
          abort.abort();
        return result;
      };
      await expect(unloading.control("create", goal.id, goal)).rejects.toThrow(
        "Native operation aborted",
      );
      expect(
        unloading.effects.filter((effect) =>
          ["create", "prompt"].includes(effect),
        ),
      ).toEqual([]);
    } finally {
      await unloading.backend.dispose();
    }
    const relocated = await backendFixture();
    try {
      const get = relocated.host.session.get;
      let location = "/projects/conversation";
      relocated.host.session.get = async (input) => ({
        ...(await get(input)),
        location: { directory: location },
      });
      const list = relocated.host.agent.list;
      relocated.host.agent.list = async (input) => ({
        ...(await list(input)),
        location: { directory: input?.location?.directory ?? location },
      });
      const capability = createObserverCapability();
      await relocated.backend.attach({
        coordinatorID: "coordinator",
        verifier: capability.verifier,
      });
      relocated.approve(async () => {
        location = "/projects/moved-during-approval";
      });
      await expect(
        relocated.backend.attach({
          coordinatorID: "coordinator",
          verifier: createObserverCapability().verifier,
        }),
      ).rejects.toThrow("changed during native approval");
      expect((await relocated.backend.inspect()).observer?.verifier).toBe(
        capability.verifier,
      );
      await expect(
        relocated.backend.read(
          capability.sign(
            2,
            1,
            {
              operation: "inspect",
              taskID: "coordinator",
              revision: 0,
              epoch: 0,
            },
            {
              dataDir: "/projects/home",
              coordinatorLocation: "/projects/conversation",
            },
          ),
        ),
      ).rejects.toThrow("coordinator location changed");
    } finally {
      await relocated.backend.dispose();
    }
    const root = resolve(".opencode/backseat");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(`${root}/setup-test-`);
    const values = new Map<string, unknown>();
    const registrations: string[] = [];
    const registration = { dispose: async () => {} };
    const setupContext = {
      app: { version: "2.2.5" },
      options: { dataDir: `${home}/data` },
      location: { directory: home },
      session: {
        async hook() {
          return registration;
        },
      },
      storage: {
        async get(key: string) {
          return values.get(key);
        },
        async set(key: string, value: unknown) {
          values.set(key, structuredClone(value));
        },
      },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
      permission: {
        async hook(kind: string, callback: typeof forceNativeAsk) {
          registrations.push(kind);
          for (const effect of ["allow", "deny"] as const) {
            const event = {
              action: "backseat.create",
              effect: effect as "allow" | "ask" | "deny",
            };
            callback(event);
            expect(event.effect).toBe(effect === "allow" ? "ask" : "deny");
          }
          return registration;
        },
      },
      rpc: {
        async register() {
          return registration;
        },
      },
      tool: {
        hook: async () => registration,
        async transform() {
          return registration;
        },
      },
      agent: { transform: async () => registration },
    } as unknown as Plugin.Context;
    try {
      const cleanup = await nativePlugin.setup(setupContext);
      expect(registrations).toEqual(["evaluate"]);
      if (typeof cleanup === "function") await cleanup();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    const incumbent = await backendFixture([
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
      const before = incumbent.root();
      incumbent.approve(async () => {
        throw new Error("Denied replacement");
      });
      await expect(
        incumbent.backend.attach({
          coordinatorID: "coordinator",
          verifier: createObserverCapability().verifier,
        }),
      ).rejects.toThrow("Denied replacement");
      expect(incumbent.root()).toEqual(before);
      incumbent.approve(async () => {});
      expect((await incumbent.control("hold", goal.id, {})).accepted).toBe(
        true,
      );
      const persisted = await incumbent.backend.inspect();
      const set = incumbent.host.storage.set;
      let writes = 0;
      incumbent.host.storage = {
        ...incumbent.host.storage,
        async set(key, value) {
          if (++writes === 2) throw new Error("Candidate write failed");
          await set(key, value);
        },
      };
      await expect(incumbent.control("hold", goal.id, {})).rejects.toThrow(
        "Candidate write failed",
      );
      const held = await incumbent.backend.inspect();
      expect(held.authority).toBe("held");
      expect(held.bindings).toEqual(persisted.bindings);
      expect(held.observer?.sequence).toBe(
        (persisted.observer?.sequence ?? 0) + 1,
      );
    } finally {
      await incumbent.backend.dispose();
    }
    const { port, approvals } = observerPort();
    const capability = createObserverCapability();
    const authority = new ObserverAuthority(
      "coordinator-home",
      port,
      observerScope,
    );
    const generation = await authority.attach(capability.verifier);
    expect(approvals).toEqual([
      {
        ...observerScope,
        coordinatorID: "coordinator-home",
        generation,
        verifier: capability.verifier,
        sequence: 0,
      },
    ]);
    const payload = {
      operation: "hold",
      taskID: goal.id,
      revision: 1,
      epoch: 1,
      body: { reason: "Manual hold" },
    };
    expect(
      await authority.authorize(
        capability.sign(generation, 1, payload, observerScope),
        payload,
      ),
    ).toEqual(payload);
    const saved = await port.load();
    expect(saved?.verifier).toBe(capability.verifier);
    const approve = port.approve;
    port.approve = async () => {
      throw new Error("Denied candidate");
    };
    await expect(
      authority.attach(createObserverCapability().verifier),
    ).rejects.toThrow("Denied candidate");
    expect(await port.load()).toEqual(saved);
    await expect(
      authority.authorize(
        capability.sign(generation, 2, payload, observerScope),
        payload,
      ),
    ).resolves.toEqual(payload);
    port.approve = approve;
    expect(JSON.stringify(saved)).not.toContain("PRIVATE KEY");
    expect(Object.keys(capability).sort()).toEqual(["sign", "verifier"]);
    const f = await backendFixture(
      [
        {
          ...goal,
          group: "team",
          workerID: "worker",
          revision: 1,
          epoch: 1,
          status: "held",
          followups: 0,
          nonprogress: 0,
        },
      ],
      STATE_BOUNDS.snapshots,
    );
    try {
      const before = await f.backend.inspect();
      const asks = f.asks.length;
      await expect(
        f.control("share", goal.id, {
          snapshot: {
            id: "excess",
            version: 1,
            content: "approved",
            group: "team",
            recipients: [goal.id],
          },
          shared: [{ id: "excess", version: 1 }],
        }),
      ).rejects.toThrow();
      expect((await f.backend.inspect()).bindings).toEqual(before.bindings);
      expect((await f.backend.inspect()).snapshots).toEqual(before.snapshots);
      expect(f.asks).toHaveLength(asks);
    } finally {
      await f.backend.dispose();
    }
  });

  it("Rejects unapproved observer mutations", async () => {
    assertNativeRpcBoundary();
    const { port } = observerPort();
    const capability = createObserverCapability();
    const authority = new ObserverAuthority(
      "coordinator-home",
      port,
      observerScope,
    );
    const expected = {
      operation: "hold",
      taskID: goal.id,
      revision: 1,
      epoch: 1,
    };
    await expect(
      authority.authorize(
        capability.sign(1, 1, expected, observerScope),
        expected,
      ),
    ).rejects.toThrow("Observer authority is not eligible");
    const generation = await authority.attach(capability.verifier);
    const proof = capability.sign(generation, 1, expected, observerScope);
    for (const invalid of [
      createObserverCapability().sign(generation, 1, expected, observerScope),
      {
        ...proof,
        payload: JSON.stringify({ ...expected, taskID: "unapproved-task" }),
      },
      capability.sign(generation, 1, { ...expected, epoch: 2 }, observerScope),
    ]) {
      await expect(authority.authorize(invalid, expected)).rejects.toThrow(
        "Observer authority is not eligible",
      );
    }
    await authority.authorize(proof, expected);
    await expect(authority.authorize(proof, expected)).rejects.toThrow(
      "Observer authority is not eligible",
    );
    authority.revoke();
    await expect(
      authority.authorize(
        capability.sign(generation, 2, expected, observerScope),
        expected,
      ),
    ).rejects.toThrow("Observer authority is not eligible");
    const denied = new ObserverAuthority(
      "coordinator-home",
      {
        ...port,
        async approve() {
          throw new Error("Denied");
        },
      },
      observerScope,
    );
    await expect(denied.attach(capability.verifier)).rejects.toThrow("Denied");
    await expect(
      denied.authorize(
        capability.sign(generation + 1, 1, expected, observerScope),
        expected,
      ),
    ).rejects.toThrow("Observer authority is not eligible");
    for (const abort of ["shutdown", "request"] as const) {
      const f = await backendFixture();
      let approve!: () => void, entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.approve(() => {
        entered();
        return new Promise<void>((resolve) => {
          approve = resolve;
        });
      });
      const request = new AbortController();
      const pending = f.backend
        .attach(
          {
            coordinatorID: "coordinator",
            verifier: createObserverCapability().verifier,
          },
          request.signal,
        )
        .then(
          () => "attached",
          () => "aborted",
        );
      await started;
      if (abort === "request") request.abort();
      else await f.backend.dispose();
      expect(await pending).toBe("aborted");
      const before = f.root();
      approve();
      await Promise.resolve();
      expect(f.root()).toEqual(before);
      if (abort === "request") await f.backend.dispose();
      expect(f.effects).toEqual(["release"]);
    }
  });
});
