import { describe, expect, it } from "bun:test";
import type {
  OpenCodeClient,
  OpenCodeEvent,
  SessionInfo,
} from "@opencode/client";
import {
  SessionController,
  type SessionControllerHost,
} from "../src/server.ts";
import { coordinatorAgent } from "../src/coordinator-agent.ts";

const context = {
  sessionID: "coordinator",
  agent: "backseat-coordinator",
  messageID: "msg_call",
  id: "call",
};
function fixture() {
  let state: unknown;
  const calls: string[] = [],
    notices: unknown[] = [];
  let uncertain = false;
  const missing = new Set<string>();
  const children = new Map<string, SessionInfo[]>();
  let pageSize = 1000;
  let fixedCursor = false;
  const sessions = new Map<string, SessionInfo>(
    ["coordinator", "worker"].map((id) => [
      id,
      {
        id,
        agent: id === "coordinator" ? "backseat-coordinator" : "engineer",
        projectID: "project",
        location: { directory: "/project" },
        time: { created: 1, updated: 1 },
      } as SessionInfo,
    ]),
  );
  const busy = new Set<string>();
  const client = {
    session: {
      async active() {
        return Object.fromEntries(
          [...busy].map((id) => [id, { type: "running" }]),
        );
      },
      async get({ sessionID }: { sessionID: string }) {
        return sessions.get(sessionID)!;
      },
      async create(input: {
        id: string;
        agent: string;
        location: { directory: string };
      }) {
        calls.push("create");
        const session = {
          ...sessions.get("worker")!,
          id: input.id,
          agent: input.agent,
          location: input.location,
        };
        sessions.set(input.id, session);
        if (uncertain) throw new Error("Transport closed");
        return session;
      },
      async synthetic(input: unknown) {
        notices.push(input);
        return input;
      },
      async prompt(input: { id: string }) {
        calls.push("prompt");
        if (uncertain) throw new Error("Transport closed");
        return { id: input.id };
      },
      message: {
        async get({ messageID }: { messageID: string }) {
          return {
            id: messageID,
            type: "assistant",
            agent: "backseat-coordinator",
            time: { created: Number(messageID.replace("msg_", "")) || 1 },
          };
        },
        async list() {
          return { data: [], more: false };
        },
      },
      async interrupt() {
        calls.push("interrupt");
        return true;
      },
      async list(input: { parentID?: string; cursor?: string }) {
        const rows = children.get(input.parentID ?? "") ?? [];
        const start = input.cursor && !fixedCursor ? Number(input.cursor) : 0;
        const data = rows.slice(start, start + pageSize);
        return {
          data,
          cursor: {
            next:
              data.length > 0
                ? fixedCursor
                  ? "same"
                  : String(start + data.length)
                : undefined,
          },
        };
      },
      async update(input: { sessionID: string }) {
        calls.push("update");
        return sessions.get(input.sessionID)!;
      },
      async remove({ sessionID }: { sessionID: string }) {
        calls.push("remove");
        if (uncertain) throw new Error("Transport closed");
        sessions.delete(sessionID);
      },
      form: {
        async get({ formID }: { formID: string }) {
          return {
            id: formID,
            sessionID: "worker",
            title: "Decision",
            fields: [],
            state: { status: "pending" },
          };
        },
        async reply(input: unknown) {
          calls.push(`form:${JSON.stringify(input)}`);
        },
        async list() {
          return [];
        },
      },
      inbox: {
        async list() {
          return [];
        },
      },
    },
    permission: {
      async get({ requestID }: { requestID: string }) {
        return {
          id: requestID,
          sessionID: "worker",
          action: "shell",
          resources: ["make test"],
        };
      },
      async reply(input: unknown) {
        calls.push(`permission:${JSON.stringify(input)}`);
      },
      request: {
        async list() {
          return { location: { directory: "/project" }, data: [] };
        },
      },
    },
    project: {
      async list() {
        return [{ id: "project", canonical: "/project", sandboxes: [] }];
      },
    },
    agent: {
      async list(input?: { location: { directory: string } }) {
        return {
          location: { directory: input?.location.directory ?? "/project" },
          data: [{ id: "engineer", hidden: false, mode: "all" }],
        };
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
  let denied = false;
  const host: SessionControllerHost = {
    native: {
      async read(work) {
        return work(client, new AbortController().signal);
      },
      identity() {
        return { mac: "service" };
      },
    },
    storage: {
      async get() {
        return structuredClone(state);
      },
      async set(_key, value) {
        state = structuredClone(value);
      },
    },
    permission: {
      async assert(input) {
        calls.push(input.action);
        if (denied) throw new Error("Configured deny");
      },
    },
    async canonical(location) {
      if (missing.has(location))
        throw Object.assign(new Error(`ENOENT: ${location}`), {
          code: "ENOENT",
        });
      return location;
    },
  };
  return {
    host,
    calls,
    notices,
    client,
    sessions,
    missing,
    busy,
    children,
    paging(size: number) {
      pageSize = size;
    },
    repeatCursor() {
      fixedCursor = true;
    },
    deny() {
      denied = true;
    },
    uncertain() {
      uncertain = true;
    },
  };
}

// spec: openspec/specs/worker-coordination/spec.md
describe("Explicit adoption", () => {
  it("Reports observation discontinuity", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    await controller.adoptSession("worker", context);
    f.sessions.delete("worker");
    await controller.event({
      type: "session.deleted",
      durable: { aggregateID: "worker" },
      data: { sessionID: "worker" },
    } as unknown as OpenCodeEvent);
    await controller.reload();
    expect(await controller.listFollowedSessions(context)).toEqual({
      sessions: [],
    });
    expect(f.notices).toHaveLength(1);
    await controller.dispose();
  });
  it("Adopts the selected existing worker", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    const result = await controller.adoptSession("worker", context);
    expect(result).toMatchObject({ sessionID: "worker", following: true });
    expect(f.calls).toEqual(["backseat.adopt"]);
    await controller.event({
      type: "session.idle",
      data: { sessionID: "worker" },
    } as OpenCodeEvent);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toMatchObject({
      sessionID: "coordinator",
      delivery: "queue",
      resume: true,
    });
    await controller.event({
      id: "permission-event",
      created: 1,
      type: "permission.asked",
      data: {
        sessionID: "worker",
        id: "permission-live",
        action: "shell",
        resources: ["make test"],
      },
    });
    expect(JSON.stringify(f.notices.at(-1))).toContain("permission-live");
    await controller.event({
      id: "form-event",
      created: 1,
      type: "form.created",
      data: {
        form: {
          sessionID: "worker",
          id: "form-live",
          title: "Decision",
          fields: [{ key: "answer", type: "string" }],
        },
      },
    });
    expect(JSON.stringify(f.notices.at(-1))).toContain("form-live");
    await controller.event({
      id: "failure-event",
      created: 1,
      type: "session.execution.failed",
      durable: { aggregateID: "worker", seq: 1, version: 1 },
      data: {
        sessionID: "worker",
        error: { type: "failure", message: "failed" },
      },
    });
    expect((f.notices.at(-1) as { text: string }).text).toContain(
      '"failed":true',
    );
    const count = f.notices.length;
    await controller.event({
      id: "notification-event",
      created: 1,
      type: "session.idle",
      metadata: { "backseat.notification": true },
      data: { sessionID: "worker" },
    });
    expect(f.notices).toHaveLength(count);
    await controller.dispose();
  });
  it("Rejects stale or denied task-free adoption", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.deny();
    await expect(controller.adoptSession("worker", context)).rejects.toThrow(
      "Configured deny",
    );
    expect(f.notices).toHaveLength(0);
    await controller.dispose();
  });
  it("Takes over from an idle or vanished coordinator", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.sessions.set("other", { ...f.sessions.get("coordinator")!, id: "other" });
    await controller.adoptSession("worker", context);
    const other = { ...context, sessionID: "other" };
    expect(await controller.adoptSession("worker", other)).toMatchObject({
      following: true,
      takeover: {
        previousCoordinatorID: "coordinator",
        reason: "previous coordinator session is idle",
      },
    });
    expect(await controller.listFollowedSessions(context)).toEqual({
      sessions: [],
    });
    expect(await controller.listFollowedSessions(other)).toMatchObject({
      sessions: [{ sessionID: "worker" }],
    });
    f.sessions.delete("other");
    f.sessions.set("third", { ...f.sessions.get("coordinator")!, id: "third" });
    expect(
      await controller.adoptSession("worker", {
        ...context,
        sessionID: "third",
      }),
    ).toMatchObject({
      takeover: {
        previousCoordinatorID: "other",
        reason: "previous coordinator session no longer exists",
      },
    });
    await controller.dispose();
  });
  it("Rejects competing ownership", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.sessions.set("other", { ...f.sessions.get("coordinator")!, id: "other" });
    await controller.adoptSession("worker", context);
    f.busy.add("coordinator");
    await expect(
      controller.adoptSession("worker", { ...context, sessionID: "other" }),
    ).rejects.toThrow("another coordinator");
    expect(
      await controller.listFollowedSessions({ ...context, sessionID: "other" }),
    ).toEqual({ sessions: [] });
    await controller.dispose();
  });
  it("Adopts a selected child without widening ownership", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.sessions.get("worker")!.parentID = "parent";
    await controller.adoptSession("worker", context);
    expect(await controller.listFollowedSessions(context)).toMatchObject({
      sessions: [{ sessionID: "worker" }],
    });
    expect(f.calls).toEqual(["backseat.adopt"]);
    await controller.dispose();
  });
  it("Rejects changed hierarchical targets", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.sessions.get("worker")!.parentID = "parent";
    await expect(
      controller.sessionOperation(
        {
          operation: "interrupt_session",
          sessionID: "worker",
          location: "/wrong",
          agent: "engineer",
          payload: {},
        },
        context,
      ),
    ).rejects.toThrow("changed");
    expect(f.calls).not.toContain("interrupt");
    await controller.dispose();
  });
  it("Rejects coordinator worker assignments", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    await expect(
      controller.createSession(
        { location: "/project", agent: "backseat-coordinator" },
        context,
      ),
    ).rejects.toThrow();
    expect(f.calls).not.toContain("create");
    await controller.dispose();
  });
  it("Reports an unknown worker location or agent as a validation failure", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    for (const input of [
      { location: "/not-a-project", agent: "engineer" },
      { location: "/project", agent: "missing-agent" },
    ])
      await expect(
        controller.createSession(input, context),
      ).rejects.toMatchObject({
        name: "Error",
        classification: "validation",
        message: "Selected worker location or agent unavailable",
      });
    expect(f.calls).not.toContain("create");
    await controller.dispose();
  });
  it("Rejects changed or unapproved manual targets", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    await expect(
      controller.adoptSession(context.sessionID, context),
    ).rejects.toThrow("own session");
    for (const kind of ["prompt", "shell"] as const)
      await expect(
        controller.sendSession(
          {
            sessionID: context.sessionID,
            location: "/project",
            agent: context.agent,
            text: "continue",
            kind,
          },
          context,
        ),
      ).rejects.toThrow("own session");
    expect(f.calls).toEqual([]);
    f.host.permission.assert = async (input) => {
      if (input.action === "backseat.send_session")
        throw new Error("Specific configured deny");
    };
    await expect(
      controller.sendSession(
        {
          sessionID: "worker",
          location: "/project",
          agent: "engineer",
          text: "continue",
        },
        context,
      ),
    ).rejects.toThrow("Specific configured deny");
    expect(f.calls).not.toContain("prompt");
    await controller.dispose();
  });
});
describe("Explicit native request replies", () => {
  it("Rejects denied stale or unsupported controls", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    await expect(
      controller.sessionOperation(
        {
          operation: "interrupt_session",
          sessionID: "coordinator",
          location: "/project",
          agent: "backseat-coordinator",
          payload: {},
        },
        context,
      ),
    ).rejects.toThrow("own session");
    f.host.permission.assert = async () => {
      f.sessions.get("coordinator")!.agent = "engineer";
    };
    await expect(
      controller.sessionOperation(
        {
          operation: "interrupt_session",
          sessionID: "worker",
          location: "/project",
          agent: "engineer",
          payload: {},
        },
        context,
      ),
    ).rejects.toThrow("changed");
    expect(f.calls).not.toContain("interrupt");
    await controller.dispose();
  });
  it("Replies to the selected native request", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    await controller.adoptSession("worker", context);
    const permission = { requestID: "permission-one", decision: "once" };
    const form = { formID: "form-one", answer: { choice: "continue" } };
    const permissionResult = await controller.sessionOperation(
      {
        operation: "reply_permission",
        sessionID: "worker",
        location: "/project",
        agent: "engineer",
        payload: permission,
      },
      context,
    );
    const formResult = await controller.sessionOperation(
      {
        operation: "reply_form",
        sessionID: "worker",
        location: "/project",
        agent: "engineer",
        payload: form,
      },
      context,
    );
    expect(permissionResult).toEqual({ status: "completed" });
    expect(formResult).toEqual({ status: "completed" });
    expect(
      f.calls.filter(
        (call) => call.startsWith("permission:") || call.startsWith("form:"),
      ),
    ).toEqual([
      `permission:${JSON.stringify({ sessionID: "worker", ...permission })}`,
      `form:${JSON.stringify({ sessionID: "worker", ...form })}`,
    ]);
    await controller.dispose();
  });
  it("Rejects a changed or unapproved reply", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.deny();
    await expect(
      controller.sessionOperation(
        {
          operation: "reply_permission",
          sessionID: "worker",
          location: "/project",
          agent: "engineer",
          payload: { requestID: "permission-one", decision: "once" },
        },
        context,
      ),
    ).rejects.toThrow("Configured deny");
    expect(f.calls.some((call) => call.startsWith("permission:"))).toBe(false);
    await controller.dispose();
  });
});
describe("Conversational manual assignment", () => {
  it("Retires confirmed deliveries without replaying expired invocations", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    const input = {
      sessionID: "worker",
      location: "/project",
      agent: "engineer",
      text: "Continue",
    };
    for (let i = 1; i <= 801; i++)
      await controller.sendSession(input, {
        ...context,
        messageID: `msg_${i}`,
      });
    const saved = (await f.host.storage.get("coordinator")) as {
      sessionDeliveries: unknown[];
    };
    expect(saved.sessionDeliveries.length).toBeLessThanOrEqual(800);
    await controller.dispose();
    const reloaded = await SessionController.load(f.host);
    await expect(
      reloaded.sendSession(input, { ...context, messageID: "msg_1" }),
    ).rejects.toThrow("expired");
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(801);
    await reloaded.dispose();
  }, 30_000);
  it("Reloads task-free delivery state without resetting tasks", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.uncertain();
    const result = await controller.createSession(
      { location: "/project", agent: "engineer" },
      context,
    );
    expect(result).toMatchObject({ status: "ambiguous" });
    await controller.dispose();
    const reloaded = await SessionController.load(f.host);
    expect(
      await reloaded.createSession(
        { location: "/project", agent: "engineer" },
        context,
      ),
    ).toMatchObject({ status: "admitted", following: true });
    expect(f.calls.filter((call) => call === "create")).toHaveLength(1);
    await reloaded.dispose();
  });
  it("Deletes the approved native subtree and preserves task history", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    await controller.adoptSession("worker", context);
    expect(await controller.deleteSession("worker", context)).toMatchObject({
      sessionID: "worker",
      status: "admitted",
    });
    expect(await controller.listFollowedSessions(context)).toEqual({
      sessions: [],
    });
    expect(f.calls.filter((call) => call === "remove")).toHaveLength(1);
    await controller.dispose();
  });
  const child = (f: ReturnType<typeof fixture>, id: string, parentID: string) =>
    ({ ...f.sessions.get("worker")!, id, parentID }) as SessionInfo;
  it("Inventories a multi-level subtree across pages", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.children.set(
      "worker",
      ["a", "b", "c"].map((id) => child(f, id, "worker")),
    );
    f.children.set("b", [child(f, "d", "b")]);
    f.paging(2);
    expect(await controller.deleteSession("worker", context)).toMatchObject({
      members: ["a", "b", "c", "d", "worker"],
      status: "admitted",
    });
    await controller.dispose();
  });
  it("Names the child that reports a different parent", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.children.set("worker", [child(f, "x", "other")]);
    await expect(controller.deleteSession("worker", context)).rejects.toThrow(
      "child x of worker",
    );
    expect(f.calls).not.toContain("remove");
    await controller.dispose();
  });
  it("Rejects a repeated continuation and an oversized subtree", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.children.set("worker", [child(f, "a", "worker")]);
    f.paging(1);
    f.repeatCursor();
    await expect(controller.deleteSession("worker", context)).rejects.toThrow(
      "repeated continuation",
    );
    const g = fixture(),
      second = await SessionController.load(g.host);
    g.children.set(
      "worker",
      Array.from({ length: 1025 }, (_, i) => child(g, `c${i}`, "worker")),
    );
    g.paging(100);
    await expect(second.deleteSession("worker", context)).rejects.toThrow(
      "more than 1024 descendants",
    );
    expect(f.calls.concat(g.calls)).not.toContain("remove");
    await controller.dispose();
    await second.dispose();
  });
  it("Rejects a subtree that changes before deletion", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    let reads = 0;
    const list = f.client.session.list.bind(f.client.session);
    f.client.session.list = (async (input: never) => {
      const page = await list(input);
      if (++reads === 1) f.children.set("worker", [child(f, "late", "worker")]);
      return page;
    }) as typeof list;
    await expect(controller.deleteSession("worker", context)).rejects.toThrow(
      "subtree changed",
    );
    expect(f.calls).not.toContain("remove");
    await controller.dispose();
  });
  it("Rejects unsafe deletion and retains uncertain outcomes", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    await expect(
      controller.deleteSession("coordinator", context),
    ).rejects.toThrow("ancestors");
    f.uncertain();
    expect(await controller.deleteSession("worker", context)).toMatchObject({
      status: "ambiguous",
    });
    await controller.dispose();
    const reloaded = await SessionController.load(f.host);
    await expect(
      reloaded.deleteSession("worker", { ...context, id: "second" }),
    ).rejects.toThrow("retained deletion");
    expect(f.calls.filter((call) => call === "remove")).toHaveLength(1);
    await reloaded.dispose();
  });
  const orphans = [
    ["location", true, false],
    ["agent", false, true],
    ["location and agent", true, true],
  ] as const;
  const orphaned = (noDirectory: boolean, noAgent: boolean) => {
    const f = fixture();
    f.sessions.get("coordinator")!.location = { directory: "/home" };
    const worker = f.sessions.get("worker")!;
    if (noAgent) delete (worker as { agent?: string }).agent;
    if (noDirectory) f.missing.add("/project");
    return f;
  };
  it("Deletes a session whose location or agent is gone", async () => {
    for (const [, noDirectory, noAgent] of orphans) {
      const f = orphaned(noDirectory, noAgent),
        controller = await SessionController.load(f.host);
      expect(await controller.deleteSession("worker", context)).toMatchObject({
        sessionID: "worker",
        status: "admitted",
      });
      expect(f.calls).toContain("remove");
      await controller.dispose();
    }
  });
  it("Updates a session whose location or agent is gone", async () => {
    for (const [, noDirectory, noAgent] of orphans) {
      const f = orphaned(noDirectory, noAgent),
        controller = await SessionController.load(f.host);
      const update = (location: string, agent?: string) =>
        controller.sessionOperation(
          {
            operation: "update_session",
            sessionID: "worker",
            location,
            ...(agent === undefined ? {} : { agent }),
            payload: { archived: true },
          },
          context,
        );
      await update("/project", noAgent ? undefined : "engineer");
      expect(f.calls).toEqual(["backseat.update_session", "update"]);
      await expect(update("/project", "other")).rejects.toThrow("changed");
      await expect(
        update("/elsewhere", noAgent ? undefined : "engineer"),
      ).rejects.toThrow("changed");
      if (!noAgent) await expect(update("/project")).rejects.toThrow("changed");
      expect(f.calls).toEqual(["backseat.update_session", "update"]);
      await controller.dispose();
    }
  });
  it("Rejects unavailable locations and agents outside update and delete", async () => {
    const interrupt = {
      operation: "interrupt_session",
      sessionID: "worker",
      location: "/project",
      agent: "engineer",
      payload: {},
    } as const;
    const missingDirectory = orphaned(true, false),
      first = await SessionController.load(missingDirectory.host);
    await expect(first.sessionOperation(interrupt, context)).rejects.toThrow(
      "ENOENT",
    );
    await first.dispose();
    const noAgent = orphaned(false, true),
      second = await SessionController.load(noAgent.host);
    await expect(second.sessionOperation(interrupt, context)).rejects.toThrow(
      "unavailable or changed",
    );
    await second.dispose();
  });
  it("Rejects delete and update when the location cannot be verified", async () => {
    const f = orphaned(false, false),
      denied = f.host.canonical;
    f.host.canonical = async (location) => {
      if (location === "/project")
        throw Object.assign(new Error("EACCES: /project"), { code: "EACCES" });
      return denied(location);
    };
    const controller = await SessionController.load(f.host);
    await expect(controller.deleteSession("worker", context)).rejects.toThrow(
      "EACCES",
    );
    await expect(
      controller.sessionOperation(
        {
          operation: "update_session",
          sessionID: "worker",
          location: "/project",
          agent: "engineer",
          payload: { archived: true },
        },
        context,
      ),
    ).rejects.toThrow("EACCES");
    expect(f.calls).toEqual([]);
    await controller.dispose();
  });
  it("Retains an uncertain manual send without resending", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    const input = {
      sessionID: "worker",
      location: "/project",
      agent: "engineer",
      text: "Continue",
    };
    f.uncertain();
    const first = await controller.sendSession(input, context);
    expect(first).toMatchObject({ status: "ambiguous" });
    await controller.dispose();
    const reloaded = await SessionController.load(f.host);
    expect(await reloaded.sendSession(input, context)).toEqual(first);
    await expect(
      reloaded.sendSession(input, { ...context, id: "second" }),
    ).rejects.toThrow("unresolved");
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(1);
    await reloaded.dispose();
  });
  it("Executes approved native session operations", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    await controller.sessionOperation(
      {
        operation: "interrupt_session",
        sessionID: "worker",
        location: "/project",
        agent: "engineer",
        payload: {},
      },
      context,
    );
    expect(f.calls).toEqual(["backseat.interrupt_session", "interrupt"]);
    f.client.session.fork = async () => ({
      ...f.sessions.get("worker")!,
      id: "forked",
    });
    f.sessions.set("forked", { ...f.sessions.get("worker")!, id: "forked" });
    const log = f.client.experimental.session.log;
    f.client.experimental.session.log = async function* (input) {
      if (input.sessionID === "forked")
        throw new Error("Observation unavailable");
      yield* log(input);
    };
    expect(
      await controller.sessionOperation(
        {
          operation: "fork_session",
          sessionID: "worker",
          location: "/project",
          agent: "engineer",
          payload: {},
        },
        context,
      ),
    ).toMatchObject({ id: "forked", following: false });
    f.uncertain();
    const creation = {
      operation: "create_native_session" as const,
      sessionID: "native-created",
      location: "/project",
      agent: "engineer",
      payload: {},
    };
    expect(await controller.sessionOperation(creation, context)).toMatchObject({
      sessionID: "native-created",
      status: "ambiguous",
    });
    await controller.dispose();
    const reloaded = await SessionController.load(f.host);
    expect(await reloaded.sessionOperation(creation, context)).toMatchObject({
      sessionID: "native-created",
      status: "admitted",
      following: true,
    });
    expect(f.calls.filter((call) => call === "create")).toHaveLength(1);
    await reloaded.dispose();
  });
  it("Takes over a selected session without inventing work", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    await controller.adoptSession("worker", context);
    expect(await controller.listFollowedSessions(context)).toMatchObject({
      sessions: [{ sessionID: "worker" }],
    });
    await controller.stopFollowing("worker", context);
    expect(await controller.listFollowedSessions(context)).toEqual({
      sessions: [],
    });
    await controller.event({
      type: "session.idle",
      data: { sessionID: "worker" },
    } as OpenCodeEvent);
    expect(f.notices).toHaveLength(0);
    await controller.dispose();
  });
  it("Sends repeated assignments without automation prerequisites", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    const input = {
      sessionID: "worker",
      location: "/project",
      agent: "engineer",
      text: "Continue",
    };
    const first = await controller.sendSession(input, context);
    expect(first).toMatchObject({ status: "admitted", sessionID: "worker" });
    await controller.sendSession(input, context);
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(1);
    await controller.sendSession(input, { ...context, id: "second" });
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(2);
    await controller.dispose();
  });
  it("Creates an assignment through separate catalog and mutation calls", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    expect(
      await controller.createSession(
        { location: "/project", agent: "engineer", title: "Worker" },
        context,
      ),
    ).toMatchObject({ following: true, agent: "engineer" });
    expect(f.calls).toEqual(["backseat.create", "create"]);
    await controller.dispose();
  });
});

describe("Explicit adoption of archived sessions", () => {
  it("Adopts an archived session", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.sessions.get("worker")!.time.archived = 2;
    expect(await controller.adoptSession("worker", context)).toMatchObject({
      sessionID: "worker",
      following: true,
    });
    await controller.dispose();
  });
});
describe("Full native session controls", () => {
  it("Controls an archived session", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.sessions.get("worker")!.time.archived = 2;
    const target = { sessionID: "worker", location: "/project" };
    await controller.sessionOperation(
      {
        operation: "interrupt_session",
        ...target,
        agent: "engineer",
        payload: {},
      },
      context,
    );
    await controller.sessionOperation(
      {
        operation: "update_session",
        ...target,
        agent: "engineer",
        payload: { archived: false },
      },
      context,
    );
    await controller.deleteSession("worker", context);
    expect(f.calls).toContain("interrupt");
    expect(f.calls).toContain("update");
    expect(f.calls).toContain("remove");
    await controller.dispose();
  });
  it("Uses any non-coordinator native agent", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    const agents = [
      { id: "engineer", hidden: false, mode: "all" },
      { id: "helper", hidden: true, mode: "subagent" },
      coordinatorAgent,
    ];
    (f.client.agent as unknown as { list: unknown }).list = async () => ({
      location: { directory: "/project" },
      data: agents,
    });
    (f.client.session as unknown as { switchAgent: unknown }).switchAgent =
      async () => {
        f.calls.push("switch");
      };
    const create = (agent: string, id: string) =>
      controller.sessionOperation(
        {
          operation: "create_native_session",
          sessionID: id,
          location: "/project",
          agent,
          payload: {},
        },
        context,
      );
    expect(await create("helper", "made")).toMatchObject({
      sessionID: "made",
    });
    await expect(
      create(coordinatorAgent.id, "second-coordinator"),
    ).rejects.toThrow("unavailable");
    const switchTo = (newAgent: string) =>
      controller.sessionOperation(
        {
          operation: "switch_session_agent",
          sessionID: "worker",
          location: "/project",
          agent: "engineer",
          payload: { newAgent },
        },
        context,
      );
    await expect(
      controller.sessionOperation(
        {
          operation: "import_session",
          sessionID: "ses_0000000000000000000000000a",
          location: "/project",
          agent: coordinatorAgent.id,
          payload: {
            transfer: {
              info: {
                id: "ses_0000000000000000000000000a",
                projectID: "prj_0000000000000000000000000a",
                agent: coordinatorAgent.id,
                location: { directory: "/project" },
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
          },
        },
        context,
      ),
    ).rejects.toThrow("unavailable");
    await switchTo("helper");
    expect(f.calls).toContain("switch");
    await expect(switchTo(coordinatorAgent.id)).rejects.toThrow("coordinator");
    await controller.dispose();
  });
  it("Accepts long sends and payloads", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    const target = {
      sessionID: "worker",
      location: "/project",
      agent: "engineer",
    };
    await controller.sendSession(
      { ...target, text: "x".repeat(200_000) },
      { ...context, messageID: "msg_long" },
    );
    expect(f.calls).toContain("prompt");
    const update = (title: string) =>
      controller.sessionOperation(
        {
          operation: "update_session",
          ...target,
          payload: { title },
        },
        context,
      );
    await update("t".repeat(100_000));
    await expect(
      controller.sessionOperation(
        {
          operation: "cancel_session_form",
          ...target,
          payload: { formID: "f".repeat(40_000) },
        },
        context,
      ),
    ).rejects.toThrow("Invalid bounded text");
    await expect(update("t".repeat(33 * 1024 * 1024))).rejects.toThrow(
      "Oversized",
    );
    await controller.dispose();
  });
});

describe("Session recap", () => {
  it("Recaps a session with its subagents listed", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    const prompts: unknown[] = [];
    const session = f.client.session as unknown as Record<string, unknown>;
    session.generate = async (input: { sessionID: string; prompt: string }) => {
      prompts.push(input);
      return `recap of ${input.sessionID}`;
    };
    session.active = async () => ({});
    session.list = async (input: { parentID?: string }) => ({
      data:
        input.parentID === "worker"
          ? [
              {
                ...f.sessions.get("worker")!,
                id: "child",
                title: "Child task",
                parentID: "worker",
              },
            ]
          : [],
      cursor: {},
    });
    const result = await controller.sessionOperation(
      {
        operation: "recap_session",
        sessionID: "worker",
        location: "/project",
        agent: "engineer",
        payload: { focus: "failing tests" },
      },
      context,
    );
    expect(result).toMatchObject({
      sessionID: "worker",
      recap: "recap of worker",
      children: [{ id: "child", title: "Child task", agent: "engineer" }],
    });
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain("failing tests");
    expect(f.calls).toContain("backseat.recap_session");
    await controller.dispose();
  });
  it("Recaps a subagent on demand", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    f.sessions.set("child", {
      ...f.sessions.get("worker")!,
      id: "child",
      parentID: "worker",
    } as never);
    const session = f.client.session as unknown as Record<string, unknown>;
    session.active = async () => ({});
    session.list = async (input: { parentID?: string }) => ({
      data:
        input.parentID === "child"
          ? [
              {
                ...f.sessions.get("worker")!,
                id: "grandchild",
                parentID: "child",
              },
            ]
          : [],
      cursor: {},
    });
    session.generate = async (input: { sessionID: string }) =>
      `recap of ${input.sessionID}`;
    const result = await controller.sessionOperation(
      {
        operation: "recap_session",
        sessionID: "child",
        location: "/project",
        agent: "engineer",
        payload: {},
      },
      context,
    );
    expect(result).toMatchObject({
      sessionID: "child",
      recap: "recap of child",
      children: [{ id: "grandchild" }],
      childrenComplete: true,
    });
    await controller.dispose();
  });
  it("Reports an incomplete child listing without losing the recap", async () => {
    const f = fixture(),
      controller = await SessionController.load(f.host);
    const session = f.client.session as unknown as Record<string, unknown>;
    session.active = async () => ({});
    session.generate = async () => "the recap";
    session.list = async () => ({
      data: [],
      cursor: { next: "loop" },
    });
    expect(
      await controller.sessionOperation(
        {
          operation: "recap_session",
          sessionID: "worker",
          location: "/project",
          agent: "engineer",
          payload: {},
        },
        context,
      ),
    ).toMatchObject({ recap: "the recap", childrenComplete: false });
    await controller.dispose();
  });
});
