import { describe, expect, it, spyOn } from "bun:test";
import { ConmanRpc } from "../src/rpc.ts";
import { coordinatorAgent } from "../src/coordinator-agent.ts";
import * as subprocess from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
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
import { creationHost, goal, coordinatorDefinition } from "./host.ts";
import {
  CoordinatorOwnership,
  ObserverAuthority,
  createFilesystemOwnershipPort,
  createObserverCapability,
  forceNativeAsk,
  registerServiceHome,
  type LockInspection,
  type ObserverRecord,
  type OwnershipPort,
} from "../src/ownership.ts";
import nativePlugin, {
  createNativeBackend,
  createWorkerObserver,
  type NativeBackendHost,
} from "../src/server.ts";
import type { SessionMessageInfo } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import type { SessionContext } from "@opencode/plugin/promise/session";

type NativeAgent = NonNullable<ReturnType<AgentEditor["get"]>>;
async function registeredCoordinator(
  passive = false,
  configured?: NativeAgent,
) {
  const root = resolve(".opencode/conman");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(`${root}/agent-test-`);
  const worker = `${home}/worker`;
  await mkdir(worker);
  const catalog = new Map<string, NativeAgent>(
    configured ? [[configured.id, structuredClone(configured)]] : [],
  );
  const values = new Map<string, unknown>();
  const defaults: unknown[] = [];
  let transforms = 0,
    disposed = 0;
  let replay: (() => void) | undefined;
  let contextHook: ((event: SessionContext) => Promise<void>) | undefined;
  let failCatalog = false;
  const registration = { dispose: async () => {} };
  const context = {
    app: { version: "2.2.5" },
    options: { home },
    location: { directory: passive ? worker : home },
    session: {
      hook: async (
        name: string,
        callback: (event: SessionContext) => Promise<void>,
      ) => {
        if (name === "context") contextHook = callback;
        return registration;
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
        await new Promise<void>((done) =>
          signal.aborted
            ? done()
            : signal.addEventListener("abort", () => done(), { once: true }),
        );
      },
    },
    permission: { hook: async () => registration },
    rpc: { register: async () => registration },
    tool: { transform: async () => registration },
    agent: {
      async list() {
        if (failCatalog) throw new Error("Unavailable catalog");
        return { location: { directory: home }, data: [...catalog.values()] };
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
  const close = await nativePlugin.setup(context);
  return {
    catalog,
    defaults,
    replay: () => replay?.(),
    transforms: () => transforms,
    disposed: () => disposed,
    async tools(agent: string, unavailable = false) {
      failCatalog = unavailable;
      const event = {
        agent,
        tools: Object.fromEntries(
          [
            "conman_control",
            "conman_inspect",
            "question",
            "skill",
            "shell",
          ].map((name) => [
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
  it("Registers the coordinator only at its home", async () => {
    for (const passive of [false, true]) {
      const f = await registeredCoordinator(passive);
      try {
        expect(f.catalog.has("conman-coordinator")).toBe(!passive);
        if (!passive) {
          const agent = structuredClone(f.catalog.get("conman-coordinator"));
          expect(agent).toMatchObject({
            id: "conman-coordinator",
            mode: "primary",
            hidden: false,
          });
          expect(agent).not.toHaveProperty("model");
          f.replay();
          expect(f.catalog.get("conman-coordinator")).toEqual(agent);
          expect(f.defaults).toEqual([]);
        }
      } finally {
        await f.close();
      }
      expect(f.disposed()).toBe(passive ? 0 : 1);
    }
  });
  it("Preserves a configured coordinator agent", async () => {
    const configured = {
      id: "conman-coordinator",
      name: "My coordinator",
      mode: "primary",
      hidden: false,
      system: "My instructions",
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
      model: { providerID: "provider", id: "model" },
      request: { settings: {}, headers: {}, body: {} },
    } as NativeAgent;
    const f = await registeredCoordinator(false, configured);
    try {
      f.replay();
      expect(f.catalog.get(configured.id)).toEqual(configured);
      expect(f.defaults).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("Preserves native approval for conversational control", async () => {
    const f = await registeredCoordinator();
    try {
      const permissions =
        f.catalog.get("conman-coordinator")?.permissions ?? [];
      const effect = (action: string) =>
        permissions
          .filter(
            (rule) =>
              rule.action === "*" ||
              rule.action === action ||
              (rule.action === "conman.*" && action.startsWith("conman.")),
          )
          .at(-1)?.effect;
      for (const tool of ["conman_inspect", "conman_control", "question"])
        expect(effect(tool)).toBe("allow");
      for (const action of [
        "conman.attach",
        "conman.create",
        "conman.recover",
        "conman.resume",
      ])
        expect(effect(action)).toBe("ask");
      for (const action of [
        "shell",
        "read",
        "edit",
        "execute",
        "webfetch",
        "subagent",
        "permission.reply",
        "form.reply",
      ])
        expect(effect(action)).toBe("deny");
      expect(await f.tools(coordinatorAgent.id)).toEqual([
        "conman_control",
        "conman_inspect",
        "question",
      ]);
      const unrelated = [
        "conman_control",
        "conman_inspect",
        "question",
        "shell",
        "skill",
      ];
      expect(await f.tools("engineer")).toEqual(unrelated);
      const bundled = f.catalog.get(coordinatorAgent.id)!;
      f.catalog.set(coordinatorAgent.id, {
        ...bundled,
        permissions: [
          ...bundled.permissions,
          { action: "browser", resource: "*", effect: "deny" },
        ],
      });
      expect(await f.tools(coordinatorAgent.id)).toEqual([
        "conman_control",
        "conman_inspect",
        "question",
      ]);
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
    for (const role of [
      "engineer",
      "collision",
      "agentless",
      "drift",
      "permissions",
      "extra-allow",
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
                    : role === "extra-allow"
                      ? {
                          permissions: [
                            ...coordinatorDefinition.permissions,
                            {
                              action: "browser",
                              resource: "*",
                              effect: "allow" as const,
                            },
                          ],
                        }
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
        ).rejects.toThrow("Conman Coordinator");
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
          permissions: coordinatorAgent.permissions.map((rule) => ({
            ...rule,
          })),
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
    completions: [],
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
      async prompt() {
        effects.push("prompt");
        return { id: "prompt" } as Awaited<
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
  const { generation } = await backend.attach({
    coordinatorID: "coordinator",
    verifier: capability.verifier,
  });
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
      proof: capability.sign(generation, ++sequence, {
        operation,
        taskID,
        revision: b?.revision ?? 0,
        epoch: b?.epoch ?? 0,
        body,
      }),
    });
  };
  const observation = (b: WorkerBinding) => {
    const snapshot = {
      home,
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
    const prefix = `home:${encodeURIComponent(home)}:worker:${encodeURIComponent(b.location)}`;
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
    failWrite: () => {
      failedWrite = true;
    },
  };
}

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
    const f = await backendFixture();
    try {
      await f.control("create", goal.id, goal);
      expect(f.effects).toEqual(["create", "prompt"]);
      expect((await f.backend.inspect()).bindings[0]?.location).toBe(
        goal.location,
      );
      expect(parseCoordinatorState(f.root()).intents[0]?.intent.status).toBe(
        "admitted",
      );
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
    const root = resolve(".opencode/conman");
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
    const registrations = [
      registerServiceHome("/projects/home"),
      registerServiceHome("/projects/home"),
    ];
    try {
      expect(() => registerServiceHome("/projects/conflict")).toThrow(
        "Conflicting canonical homes",
      );
      registrations[0]!();
      expect(() => registerServiceHome("/projects/conflict")).toThrow(
        "Conflicting canonical homes",
      );
    } finally {
      registrations.forEach((release) => release());
    }
    const home = await fixture();
    const first = authority(home, "first");
    try {
      expect(await first.claim()).toBe("owned");
      const lock = resolve(home, ".opencode/conman/ownership.lock");
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
          const directory = resolve(target, ".opencode");
          if (unsafe === "symlink") await symlink(home, directory);
          else {
            await mkdir(resolve(directory, "conman"), {
              recursive: true,
              mode: 0o700,
            });
            if (unsafe === "mode") await chmod(directory, 0o777);
            if (unsafe === "malformed")
              await writeFile(
                resolve(directory, "conman/ownership.lock"),
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
              await writeFile(
                resolve(directory, "conman/ownership.lock"),
                bytes,
                { mode: 0o600 },
              );
            }
            if (unsafe === "oversized")
              await writeFile(
                resolve(directory, "conman/ownership.lock"),
                " ".repeat(8193),
                { mode: 0o600 },
              );
            if (unsafe === "lock-mode")
              await writeFile(resolve(directory, "conman/ownership.lock"), "", {
                mode: 0o644,
              });
            if (unsafe === "lock-symlink")
              await symlink(lock, resolve(directory, "conman/ownership.lock"));
            if (unsafe === "hardlink")
              await link(lock, resolve(directory, "conman/ownership.lock"));
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

  it("Requires explicit stale-owner recovery", async () => {
    await mockAuthority("recovery");
    const home = await fixture();
    const approvals: string[] = [];
    const next = authority(home, "next", async (_home, owner) => {
      approvals.push(owner);
      expect(await child(home, "approval-racer")).toBe("held");
    });
    try {
      expect(await child(home, "crashed", true)).toBe("owned");
      const lock = resolve(home, ".opencode/conman/ownership.lock");
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
              status: result.snapshot.bindings[0]?.status,
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
  const proof = capability.sign(1, 1, {
    operation: "hold",
    taskID: "api-task",
    revision: 1,
    epoch: 1,
    body: {},
  });
  const valid = { operation: "hold" as const, taskID: "api-task", proof };
  const parse = ConmanRpc.methods.control.input["~standard"].validate;
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
  expect(ConmanRpc.methods.attach.input["~standard"].validate(attach)).toEqual({
    value: attach,
  });
  expect(
    ConmanRpc.methods.attach.input["~standard"].validate({
      ...attach,
      confirmed: true,
    }),
  ).toHaveProperty("issues");
  const snapshot = {
    version: 1 as const,
    home: "/projects/coordinator",
    authority: "owned" as const,
    bindings: [],
    snapshots: [],
    intents: [],
    completions: [],
  };
  expect(
    ConmanRpc.methods.control.output["~standard"].validate({
      accepted: true,
      snapshot,
    }),
  ).toEqual({ value: { accepted: true, snapshot } });
  expect(
    ConmanRpc.methods.control.output["~standard"].validate({
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
    const root = resolve(".opencode/conman");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(`${root}/setup-test-`);
    const values = new Map<string, unknown>();
    const registrations: string[] = [];
    const registration = { dispose: async () => {} };
    const setupContext = {
      app: { version: "2.2.5" },
      options: { home },
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
              action: "conman.create",
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
      const observerHost = {
        session: {
          get: incumbent.host.session.get,
          context: incumbent.host.session.context!,
        },
        storage: incumbent.host.storage,
        canonical: incumbent.host.canonical,
      };
      const passive = await createWorkerObserver(
        observerHost,
        "/projects/home",
        "/projects/passive",
      );
      try {
        const before = structuredClone([...incumbent.values]);
        await expect(
          createWorkerObserver(
            observerHost,
            "/projects/conflict",
            "/projects/other",
          ),
        ).rejects.toThrow("Conflicting canonical homes");
        expect([...incumbent.values]).toEqual(before);
      } finally {
        await passive.dispose();
      }
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
    const allowed = {
      action: "conman.observer.attach",
      effect: "allow" as "allow" | "ask" | "deny",
    };
    forceNativeAsk(allowed);
    expect(allowed.effect).toBe("ask");
    const denied = {
      action: "conman.observer.attach",
      effect: "deny" as const,
    };
    forceNativeAsk(denied);
    expect(denied.effect).toBe("deny");
    const { port, approvals } = observerPort();
    const capability = createObserverCapability();
    const authority = new ObserverAuthority("coordinator-home", port);
    const generation = await authority.attach(capability.verifier);
    expect(approvals).toEqual([
      {
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
        capability.sign(generation, 1, payload),
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
      authority.authorize(capability.sign(generation, 2, payload), payload),
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
    const authority = new ObserverAuthority("coordinator-home", port);
    const expected = {
      operation: "hold",
      taskID: goal.id,
      revision: 1,
      epoch: 1,
    };
    await expect(
      authority.authorize(capability.sign(1, 1, expected), expected),
    ).rejects.toThrow("Observer authority is not eligible");
    const generation = await authority.attach(capability.verifier);
    const proof = capability.sign(generation, 1, expected);
    for (const invalid of [
      createObserverCapability().sign(generation, 1, expected),
      {
        ...proof,
        payload: JSON.stringify({ ...expected, taskID: "unapproved-task" }),
      },
      capability.sign(generation, 1, { ...expected, epoch: 2 }),
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
      authority.authorize(capability.sign(generation, 2, expected), expected),
    ).rejects.toThrow("Observer authority is not eligible");
    const denied = new ObserverAuthority("coordinator-home", {
      ...port,
      async approve() {
        throw new Error("Denied");
      },
    });
    await expect(denied.attach(capability.verifier)).rejects.toThrow("Denied");
    await expect(
      denied.authorize(capability.sign(generation + 1, 1, expected), expected),
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
