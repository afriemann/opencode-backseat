import { describe, expect, it } from "bun:test";
import type { OpenCodeClient, SessionInfo } from "@opencode/client";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import {
  createCoordinationTools,
  type CoordinationToolPort,
} from "../src/tools.ts";

function fixture() {
  const rows = ["running", "waiting", "inactive", "unknown"].map(
    (status, index) => ({
      id: status,
      title: status,
      projectID: "project",
      agent: "engineer",
      parentID: index === 1 ? "running" : undefined,
      location: { directory: "/projects/one" },
      time: { created: 1, updated: 1 },
    }),
  ) as SessionInfo[];
  const queries: unknown[] = [],
    controls: unknown[] = [];
  let nativeCursor: string | undefined,
    clock = 0,
    owned = true;
  const task = {
    id: "task",
    workerID: "running",
    location: "/projects/one",
    status: "held",
    group: "team",
  };
  const client = {
    session: {
      async list(input: unknown) {
        queries.push(input);
        return { data: rows, cursor: { next: nativeCursor } };
      },
      async get({ sessionID }: { sessionID: string }) {
        if (sessionID === "unknown") throw new Error("Unavailable");
        return rows.find((row) => row.id === sessionID)!;
      },
      async active() {
        return { running: { type: "running" } };
      },
      form: {
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
      request: {
        async list() {
          return {
            location: { directory: "/projects/one" },
            data: [{ id: "ask", sessionID: "waiting" }],
          };
        },
      },
    },
    project: {
      async list() {
        return [
          {
            id: "project",
            name: "One",
            canonical: "/projects/one",
            sandboxes: [],
          },
        ];
      },
    },
    agent: {
      async list() {
        return {
          location: { directory: "/projects/one" },
          data: [{ id: "engineer", hidden: false, mode: "all" }],
        };
      },
    },
  } as unknown as OpenCodeClient;
  const port = {
    native: {
      async read<T>(
        operation: (client: OpenCodeClient, signal: AbortSignal) => Promise<T>,
      ) {
        return operation(client, new AbortController().signal);
      },
      identity() {
        return { mac: "" };
      },
      dispose() {},
    },
    backend: {
      async inspectDeletions() {
        return [];
      },
      async inspect() {
        return {
          authority: owned ? "owned" : "held",
          bindings: [task],
          intents: [
            { intent: { taskID: "task", id: "included" } },
            { intent: { taskID: "other", id: "excluded" } },
          ],
          completions: [{ taskID: "task" }, { taskID: "other" }],
          snapshots: [
            { id: "included", recipients: ["task"] },
            { id: "excluded", recipients: ["other"] },
          ],
        };
      },
      async nativeControl(...input: unknown[]) {
        controls.push(input);
        return { accepted: true };
      },
      async recover(...input: unknown[]) {
        controls.push(["recover", ...input]);
        return { authority: "held" };
      },
      async deleteSession(...input: unknown[]) {
        controls.push(["delete", ...input]);
        return { sessionID: input[0], status: "deleted", affectedTasks: [] };
      },
    },
    async canonical(location: string) {
      return location;
    },
    async authorize() {},
    signal: new AbortController().signal,
    now: () => clock,
  } as unknown as CoordinationToolPort;
  const registry = createCoordinationTools(port);
  const context = {
    sessionID: "coordinator",
    agent: "backseat-coordinator",
    messageID: "message",
    id: "call",
    signal: new AbortController().signal,
  } as ToolContext;
  async function call(name: string, input: unknown = {}, caller = context) {
    return (
      await registry.tools
        .find((tool) => tool.name === name)!
        .execute(input, caller)
    ).output as Record<string, unknown>;
  }
  return {
    rows,
    queries,
    controls,
    port,
    registry,
    context,
    client,
    call,
    cursor(value?: string) {
      nativeCursor = value;
    },
    expire() {
      clock = 300_001;
    },
    advance(milliseconds: number) {
      clock += milliseconds;
    },
    hold() {
      owned = false;
    },
  };
}

// spec: openspec/specs/worker-coordination/spec.md
describe("Fine-grained Code Mode queries", () => {
  it("Returns native session timestamps", async () => {
    const f = fixture();
    f.rows.splice(2);
    f.rows[0]!.time = {
      created: 1_700_000_000_123,
      updated: 1_700_000_100_456,
    };
    f.rows[1]!.time = {
      created: 1_700_001_000_789,
      updated: 1_700_001_100_012,
    };
    const get = f.client.session.get;
    f.client.session.get = async (input) => {
      const row = await get(input);
      return {
        ...row,
        time: { ...row.time, updated: row.time.updated + 1_000 },
      };
    };
    const first = await f.call("list_sessions", {
      limit: 1,
      includeSubagents: true,
    });
    const cursor = first.cursor;
    expect(first).toMatchObject({
      sessions: [
        {
          id: "running",
          createdAt: 1_700_000_000_123,
          updatedAt: 1_700_000_101_456,
        },
      ],
      cursor: expect.any(String),
    });
    f.rows[1]!.time.updated += 2_000;
    expect(
      await f.call("list_sessions", {
        limit: 1,
        includeSubagents: true,
        cursor,
      }),
    ).toMatchObject({
      sessions: [
        {
          id: "waiting",
          createdAt: 1_700_001_000_789,
          updatedAt: 1_700_001_103_012,
        },
      ],
    });
  });

  it("Preserves timestamps when status refresh is unavailable", async () => {
    const f = fixture();
    f.rows[3]!.time = {
      created: 1_700_002_000_345,
      updated: 1_700_002_100_678,
    };
    expect(
      await f.call("list_sessions", { statuses: ["unknown"] }),
    ).toMatchObject({
      sessions: [
        {
          id: "unknown",
          createdAt: 1_700_002_000_345,
          updatedAt: 1_700_002_100_678,
          status: "unknown",
        },
      ],
      partial: true,
      unknownCount: 1,
    });
  });

  it("Filters hierarchical sessions with multiple statuses", async () => {
    const f = fixture();
    expect(await f.call("list_sessions")).toMatchObject({
      sessions: [
        { id: "running", projectID: "project", parentID: null, topLevel: true },
        { id: "inactive" },
      ],
      partial: true,
      unknownCount: 1,
    });
    expect(
      await f.call("list_sessions", {
        statuses: ["running", "waiting"],
        includeSubagents: true,
        projectID: "project",
        location: "/projects/one",
      }),
    ).toMatchObject({ sessions: [{ id: "running" }, { id: "waiting" }] });
    expect(f.queries.at(-1)).toMatchObject({
      project: "project",
      directory: "/projects/one",
    });
    expect(await f.call("list_sessions", { taskIDs: ["task"] })).toMatchObject({
      sessions: [{ id: "running" }],
    });
    expect(await f.call("list_sessions", { parentID: null })).toMatchObject({
      sessions: [{ id: "running" }, { id: "inactive" }],
    });
    expect(f.queries.at(-1)).toMatchObject({ parentID: null, archived: false });
    expect(
      await f.call("list_sessions", { statuses: ["unknown"] }),
    ).toMatchObject({ sessions: [{ id: "unknown" }] });
    expect(
      await f.call("list_sessions", {
        agent: "engineer",
        statuses: ["inactive"],
        search: "inactive",
        includeArchived: true,
      }),
    ).toMatchObject({ sessions: [{ id: "inactive" }] });
    expect(f.queries.at(-1)).toHaveProperty("search", "inactive");
    expect(f.queries.at(-1)).not.toHaveProperty("archived");
    expect(
      await f.call("list_sessions", {
        statuses: ["inactive"],
        search: "native-match",
      }),
    ).toMatchObject({ sessions: [{ id: "inactive" }] });
    for (const input of [
      { extra: true },
      { statuses: ["invalid"] },
      { statuses: [] },
      { limit: 201 },
      { location: "relative" },
      { includeArchived: "yes" },
      { includeSubagents: "yes" },
    ])
      await expect(f.call("list_sessions", input)).rejects.toThrow();
    f.hold();
    await expect(
      f.call("list_sessions", { taskIDs: ["task"] }),
    ).rejects.toThrow("task store");
    f.client.session.list = async () => {
      throw new Error("Unavailable native inventory");
    };
    expect(await f.call("list_sessions")).toMatchObject({
      available: false,
      partial: true,
      sessions: [],
      reason: expect.any(String),
    });
  });

  it("Excludes subagents by default with explicit hierarchy selection", async () => {
    const f = fixture();
    for (const includeSubagents of [undefined, false, true]) {
      const input = includeSubagents === undefined ? {} : { includeSubagents };
      const result = await f.call("list_sessions", input);
      expect(
        (result.sessions as { id: string }[]).map((row) => row.id),
      ).toEqual(
        includeSubagents
          ? ["running", "waiting", "inactive"]
          : ["running", "inactive"],
      );
      if (includeSubagents)
        expect(f.queries.at(-1)).not.toHaveProperty("parentID");
      else expect(f.queries.at(-1)).toHaveProperty("parentID", null);
      for (const [parentID, expected] of [
        [null, ["running", "inactive"]],
        ["running", ["waiting"]],
        ["waiting", []],
      ] as const) {
        const selected = await f.call("list_sessions", { ...input, parentID });
        expect(
          (selected.sessions as { id: string }[]).map((row) => row.id),
        ).toEqual([...expected]);
        expect(f.queries.at(-1)).toHaveProperty("parentID", parentID);
      }
    }
    const limited = await f.call("list_sessions", { limit: 2 });
    expect((limited.sessions as { id: string }[]).map((row) => row.id)).toEqual(
      ["running", "inactive"],
    );
  });

  it("Continues filtered queries without exposing native cursors", async () => {
    for (const { input, expectedSecond, expectedNext } of [
      { input: {}, expectedSecond: ["inactive"], expectedNext: ["next-root"] },
      {
        input: { includeSubagents: true },
        expectedSecond: ["waiting"],
        expectedNext: ["inactive"],
      },
      {
        input: { parentID: "running" },
        expectedSecond: [],
        expectedNext: undefined,
      },
    ]) {
      const hierarchy = fixture();
      hierarchy.cursor("next-native-page");
      const first = await hierarchy.call("list_sessions", {
        ...input,
        limit: 1,
      });
      await expect(
        hierarchy.call("list_sessions", {
          ...input,
          limit: 1,
          cursor: first.cursor,
          includeSubagents: !(
            "includeSubagents" in input && input.includeSubagents
          ),
        }),
      ).rejects.toThrow("Continuation");
      const nextRoot = {
        ...hierarchy.rows[0]!,
        id: "next-root",
      };
      hierarchy.rows.push(nextRoot);
      hierarchy.client.session.list = async (query) => {
        hierarchy.queries.push(query);
        return { data: [nextRoot], cursor: {} };
      };
      const second = await hierarchy.call("list_sessions", {
        ...input,
        limit: 1,
        cursor: first.cursor,
        ...(!("includeSubagents" in input) ? { includeSubagents: false } : {}),
      });
      expect(
        (second.sessions as { id: string }[]).map((row) => row.id),
      ).toEqual(expectedSecond);
      if (!expectedNext) continue;
      const next = await hierarchy.call("list_sessions", {
        ...input,
        limit: 1,
        cursor: second.cursor,
      });
      expect((next.sessions as { id: string }[]).map((row) => row.id)).toEqual(
        expectedNext,
      );
    }
    const f = fixture();
    const nativeCursor = "native-private-cursor-".repeat(30);
    f.cursor(nativeCursor);
    const first = await f.call("list_sessions", {
      statuses: ["inactive"],
      limit: 1,
    });
    const cursor = first.cursor;
    expect(first).toMatchObject({
      sessions: [{ id: "inactive" }],
      cursor: expect.stringMatching(/^page-[0-9-]+$/),
    });
    expect(JSON.stringify(first)).not.toContain(nativeCursor);
    await expect(
      f.call("list_sessions", { statuses: ["running"], limit: 1, cursor }),
    ).rejects.toThrow("Continuation");
    await expect(
      f.call("list_sessions", { statuses: ["inactive"], limit: 1, cursor }, {
        ...f.context,
        sessionID: "another",
      } as ToolContext),
    ).rejects.toThrow("Continuation");
    f.cursor();
    await f.call("list_sessions", { statuses: ["inactive"], limit: 1, cursor });
    expect(f.queries.at(-1)).toHaveProperty("cursor", nativeCursor);
    const restarted = fixture();
    restarted.cursor(nativeCursor);
    await restarted.call("list_sessions", { statuses: ["inactive"], limit: 1 });
    restarted.cursor();
    await expect(
      restarted.call("list_sessions", {
        statuses: ["inactive"],
        limit: 1,
        cursor,
      }),
    ).rejects.toThrow("Continuation unavailable");
    f.expire();
    await expect(
      f.call("list_sessions", { statuses: ["inactive"], limit: 1, cursor }),
    ).rejects.toThrow("Continuation");
    const changed = fixture();
    const running = await changed.call("list_sessions", {
      statuses: ["running", "waiting"],
      includeSubagents: true,
      limit: 1,
    });
    changed.client.permission.request.list = async () => ({
      location: { directory: "/projects/one" },
      data: [],
    });
    expect(
      await changed.call("list_sessions", {
        statuses: ["running", "waiting"],
        includeSubagents: true,
        limit: 1,
        cursor: running.cursor,
      }),
    ).toMatchObject({ sessions: [] });
    const empty = fixture();
    empty.cursor(nativeCursor);
    const page = await empty.call("list_sessions", { agent: "other" });
    expect(page).toMatchObject({ sessions: [], partial: true });
    empty.rows.splice(0, empty.rows.length, {
      ...empty.rows[0]!,
      id: "next",
      agent: "other",
    });
    empty.cursor();
    expect(
      await empty.call("list_sessions", {
        agent: "other",
        cursor: page.cursor,
      }),
    ).toMatchObject({ sessions: [{ id: "next" }], partial: true });
    const evicted = fixture();
    const retained = await evicted.call("list_sessions", { limit: 1 });
    for (let index = 0; index < 128; index++)
      await evicted.call("list_sessions", { limit: 1 });
    await expect(
      evicted.call("list_sessions", { limit: 1, cursor: retained.cursor }),
    ).rejects.toThrow("Continuation");
    evicted.registry.dispose();
    await expect(evicted.call("list_sessions")).rejects.toThrow("unavailable");
    const absolute = fixture();
    const initial = await absolute.call("list_sessions", {
      limit: 1,
      includeSubagents: true,
    });
    absolute.advance(299_999);
    const continued = await absolute.call("list_sessions", {
      limit: 1,
      includeSubagents: true,
      cursor: initial.cursor,
    });
    absolute.expire();
    await expect(
      absolute.call("list_sessions", {
        limit: 1,
        includeSubagents: true,
        cursor: continued.cursor,
      }),
    ).rejects.toThrow("Continuation");
  });

  it("Lists catalogs and retrieves task details independently", async () => {
    const f = fixture();
    expect(await f.call("list_projects")).toMatchObject({
      projects: [{ projectID: "project", location: "/projects/one" }],
    });
    expect(
      await f.call("list_agents", { location: "/projects/one" }),
    ).toMatchObject({ agents: ["engineer"] });
    expect(
      await f.call("list_tasks", { statuses: ["held"], group: "team" }),
    ).toMatchObject({ tasks: [{ id: "task" }] });
    expect(await f.call("get_task", { taskID: "task" })).toMatchObject({
      task: { id: "task" },
      intents: [{ intent: { id: "included" } }],
      completions: [{ taskID: "task" }],
      snapshots: [{ id: "included" }],
      deletions: [],
    });
    expect(
      await f.call("list_tasks", { statuses: ["complete"] }),
    ).toMatchObject({ tasks: [] });
    await f.call("dispatch_task", {
      taskID: "task",
      text: "Requested work",
      scope: ["source"],
    });
    expect(f.controls[0]).toMatchObject([
      "dispatch",
      "task",
      { text: "Requested work", scope: ["source"] },
      expect.objectContaining({ sessionID: "coordinator" }),
    ]);
    for (const [name, input, expected] of [
      [
        "create_session",
        { task: { id: "task" } },
        ["create", "task", { id: "task" }],
      ],
      [
        "adopt_session",
        { task: { id: "task" }, sessionID: "worker" },
        ["adopt", "task", { goal: { id: "task" }, workerID: "worker" }],
      ],
      ["take_over_task", { taskID: "task" }, ["takeover", "task", {}]],
      ["hold_task", { taskID: "task" }, ["hold", "task", {}]],
      [
        "share_context",
        { taskID: "task", shared: [] },
        ["share", "task", { shared: [] }],
      ],
    ] as const) {
      expect(await f.call(name, input)).toMatchObject({ accepted: true });
      expect(f.controls.at(-1)).toMatchObject([
        ...expected,
        expect.objectContaining({
          sessionID: "coordinator",
          agent: "backseat-coordinator",
          messageID: "message",
          id: "call",
        }),
      ]);
    }
    expect(await f.call("recover_runtime")).toMatchObject({
      authority: "held",
    });
    expect((f.controls.at(-1) as unknown[]).slice(0, 3)).toMatchObject([
      "recover",
      { coordinatorID: "coordinator" },
      expect.objectContaining({ sessionID: "coordinator" }),
    ]);
    expect(
      await f.call("delete_session", { sessionID: "worker" }),
    ).toMatchObject({ status: "deleted", sessionID: "worker" });
    expect(f.controls.at(-1)).toMatchObject([
      "delete",
      "worker",
      expect.objectContaining({ sessionID: "coordinator" }),
    ]);
    f.hold();
    await expect(f.call("list_tasks")).rejects.toThrow("task store");
    await expect(f.call("get_task", { taskID: "task" })).rejects.toThrow(
      "task store",
    );
  });
});
