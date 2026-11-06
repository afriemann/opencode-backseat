import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, mkdir, rm, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import * as connections from "../src/native-connection.ts";
import { promisePlugin } from "../src/server.ts";
import { coordinatorAgent } from "../src/coordinator-agent.ts";

// spec: openspec/specs/worker-coordination/spec.md
describe("Restricted conversational coordination", () => {
  it.each([
    "Preserves cross-project control under inherited policy",
    "Rejects disallowed coordinator tool execution",
    "Bootstraps without disclosing task state",
    "Rejects unauthorised shared-state reads",
  ])("%s", async (scenario) => {
    const root = resolve(".opencode/backseat");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(`${root}/events-`);
    const notices: unknown[] = [];
    const tools = new Map<
      string,
      { execute(input: unknown, context: unknown): Promise<unknown> }
    >();
    const hooks = new Map<string, (event: unknown) => Promise<void>>();
    let bootstrap!: () => Promise<unknown>;
    const registration = { dispose: async () => {} };
    let fire!: () => void, processed!: () => void;
    let subscriptions = 0;
    const trigger = new Promise<void>((done) => {
      fire = done;
    });
    const finished = new Promise<void>((done) => {
      processed = done;
    });
    const session = (id: string) => ({
      id,
      agent: id === "coordinator" ? coordinatorAgent.id : "engineer",
      projectID: "project",
      location: { directory: id === "coordinator" ? home : `${home}/external` },
      time: { created: 1, updated: 1 },
    });
    await mkdir(`${home}/external`);
    const client = {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => session(sessionID),
        synthetic: async (input: unknown) => {
          notices.push(input);
          return input;
        },
        form: { list: async () => [] },
      },
      permission: {
        request: {
          list: async () => ({
            location: { directory: `${home}/external` },
            data: [],
          }),
        },
      },
      experimental: {
        session: {
          async *log({ sessionID }: { sessionID: string }) {
            yield { type: "log.synced", aggregateID: sessionID, seq: 0 };
          },
        },
      },
    } as unknown as OpenCodeClient;
    const stub = spyOn(
      connections,
      "createNativeConnection",
    ).mockImplementation(() => ({
      read: (work) => work(client, new AbortController().signal),
      identity: () => ({ mac: "service" }),
      dispose() {},
    }));
    const context = {
      app: { version: "2.2.5" },
      options: { dataDir: `${home}/data` },
      location: { directory: home },
      session: {
        get: client.session.get,
        hook: async (name: string, hook: (event: unknown) => Promise<void>) => {
          hooks.set(name, hook);
          return registration;
        },
      },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          if (++subscriptions === 1) throw new Error("Event transport closed");
          await trigger;
          yield {
            type: "session.idle",
            location: { directory: `${home}/external` },
            data: { sessionID: "worker" },
          } as OpenCodeEvent;
          processed();
          await new Promise<void>((done) =>
            signal.aborted
              ? done()
              : signal.addEventListener("abort", () => done(), { once: true }),
          );
        },
      },
      permission: { assert: async () => {} },
      rpc: {
        register: async (
          _contract: unknown,
          handlers: { bootstrap: () => Promise<unknown> },
        ) => {
          bootstrap = handlers.bootstrap;
          return registration;
        },
      },
      agent: {
        list: async () => ({
          location: { directory: home },
          data: [structuredClone(coordinatorAgent)],
        }),
        transform: async () => registration,
      },
      tool: {
        hook: async (name: string, hook: (event: unknown) => Promise<void>) => {
          hooks.set(name, hook);
          return registration;
        },
        transform: async (change: (editor: unknown) => void) => {
          change({
            namespace() {},
            add(tool: {
              name: string;
              execute(input: unknown, context: unknown): Promise<unknown>;
            }) {
              tools.set(tool.name, tool);
            },
          });
          return registration;
        },
      },
    } as unknown as Plugin.Context;
    let close: unknown;
    try {
      close = await promisePlugin(() => {}).setup(context);
      const identity = {
        sessionID: "coordinator",
        agent: coordinatorAgent.id,
        messageID: "message",
        id: "call",
        signal: new AbortController().signal,
      };
      if (scenario === "Bootstraps without disclosing task state") {
        expect(await bootstrap()).toMatchObject({ authority: "owned" });
        expect(Object.keys((await bootstrap()) as object).sort()).toEqual([
          "authority",
          "dataDir",
        ]);
        return;
      }
      if (scenario === "Rejects unauthorised shared-state reads") {
        await expect(
          tools
            .get("list_followed_sessions")!
            .execute({}, { ...identity, agent: "engineer" }),
        ).rejects.toThrow();
        return;
      }
      if (scenario === "Rejects disallowed coordinator tool execution") {
        const catalog = {
          ...identity,
          tools: { shell: {}, execute: {}, backseat_stop_following: {} },
        };
        await hooks.get("context")!(catalog);
        expect(Object.keys(catalog.tools)).toEqual([
          "execute",
          "backseat_stop_following",
        ]);
        await expect(
          hooks.get("execute.before")!({ ...identity, tool: "shell" }),
        ).rejects.toThrow("not permitted");
        return;
      }
      await tools
        .get("adopt_session")!
        .execute({ sessionID: "worker" }, identity);
      fire();
      await Promise.race([
        finished,
        new Promise((done) => setTimeout(done, 1500)),
      ]);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        sessionID: "coordinator",
        delivery: "queue",
        resume: true,
      });
    } finally {
      fire();
      if (typeof close === "function") await close();
      stub.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });
  it.each([
    "Preserves native approval for conversational control",
    "Holds a competing or unsafe authority",
  ])("%s", async (scenario) => {
    const root = resolve(".opencode/backseat");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(`${root}/runtime-`);
    const permissions: string[] = [];
    const tools: string[] = [];
    let bootstrap!: () => Promise<unknown>;
    if (scenario === "Holds a competing or unsafe authority") {
      await mkdir(`${home}/data`);
      await chmod(`${home}/data`, 0o777);
    }
    const registration = { dispose: async () => {} };
    const factory = connections.createNativeConnection;
    const stub = spyOn(
      connections,
      "createNativeConnection",
    ).mockImplementation((options) =>
      factory({ ...options, registration: async () => undefined }),
    );
    const context = {
      app: { version: "2.2.5" },
      options: { dataDir: `${home}/data` },
      location: { directory: home },
      session: { hook: async () => registration },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          await new Promise<void>((done) =>
            signal.aborted
              ? done()
              : signal.addEventListener("abort", () => done(), { once: true }),
          );
        },
      },
      permission: {
        hook: async (name: string) => {
          permissions.push(name);
          return registration;
        },
        assert: async () => {},
      },
      rpc: {
        register: async (
          _contract: unknown,
          handlers: { bootstrap: () => Promise<unknown> },
        ) => {
          bootstrap = handlers.bootstrap;
          return registration;
        },
      },
      agent: {
        transform: async (change: (editor: unknown) => void) => {
          change({
            get: () => undefined,
            update: (_id: string, update: (value: unknown) => void) =>
              update(structuredClone(coordinatorAgent)),
          });
          return registration;
        },
      },
      tool: {
        hook: async () => registration,
        transform: async (change: (editor: unknown) => void) => {
          change({
            namespace() {},
            add(tool: { name: string }) {
              tools.push(tool.name);
            },
          });
          return registration;
        },
      },
    } as unknown as Plugin.Context;
    let close: unknown;
    try {
      close = await promisePlugin(() => {}).setup(context);
      expect(permissions).toEqual([]);
      expect(tools).toContain("stop_following");
      expect(tools).not.toContain("start_supervision");
      if (scenario === "Holds a competing or unsafe authority")
        expect(await bootstrap()).toMatchObject({ authority: "held" });
    } finally {
      stub.mockRestore();
      if (typeof close === "function") await close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
