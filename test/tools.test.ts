import { describe, expect, it } from "bun:test";
import type { OpenCodeClient, SessionInfo } from "@opencode/client";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { NativeConnectionError } from "../src/native-connection.ts";
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
    clock = 0;
  const client = {
    form: {
      async list() {
        return { location: { directory: "/projects/one" }, data: [] };
      },
    },
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
    model: {
      async list(input: { location: { directory: string } }) {
        return {
          location: {
            directory:
              input.location.directory === "/projects/one"
                ? "/projects/one"
                : "/elsewhere",
          },
          data: [
            {
              id: "anthropic/sonnet",
              modelID: "sonnet",
              providerID: "anthropic",
              name: "Sonnet",
              status: "active",
              enabled: true,
              variants: [{ id: "high" }],
            },
            {
              id: "anthropic/off",
              modelID: "off",
              providerID: "anthropic",
              name: "Off",
              status: "active",
              enabled: false,
              variants: [],
            },
          ],
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
      async listFollowedSessions() {
        return { sessions: [{ sessionID: "running" }], deliveries: [] };
      },
      async createSession(...input: unknown[]) {
        controls.push(["create", ...input]);
        return { following: true };
      },
      async adoptSession(...input: unknown[]) {
        controls.push(["adopt", ...input]);
        return { following: true };
      },
      async stopFollowing(...input: unknown[]) {
        controls.push(["stop", ...input]);
        return { following: false };
      },
      async sendSession(...input: unknown[]) {
        controls.push(["send_session", ...input]);
        return {
          sessionID: "worker",
          sendID: "msg_native",
          status: "admitted",
        };
      },
      async sessionOperation(...input: unknown[]) {
        controls.push(["session_operation", ...input]);
        return { status: "completed" };
      },
      async deleteSession(...input: unknown[]) {
        controls.push(["delete", ...input]);
        return { sessionID: input[0], status: "deleted" };
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
  };
}

// spec: openspec/specs/worker-coordination/spec.md
describe("Fine-grained Code Mode queries", () => {
  it("Pages selected session content incrementally", async () => {
    const f = fixture();
    const target = {
      sessionID: "running",
      location: "/projects/one",
      agent: "engineer",
    };
    const projection = [
      {
        id: "idle-1",
        type: "idle",
        outcome: "succeeded",
        time: { created: 1 },
      },
    ];
    Object.assign(f.client, {
      message: {
        list: async () => ({
          data: projection,
          cursor: { next: "native-next" },
        }),
      },
      experimental: {
        session: {
          instructions: { entry: { list: async () => [] } },
          stats: async () => ({}),
          export: async () => ({ info: f.rows[0], messages: projection }),
          log: async function* () {
            yield { type: "log.synced", aggregateID: "running", seq: 0 };
          },
        },
      },
    });
    Object.assign(f.client.session, {
      context: async () => [],
      diff: async () => [],
      message: { get: async () => projection[0] },
      form: {
        list: async () => [],
        get: async () => ({ id: "form", sessionID: "running" }),
      },
      inbox: {
        list: async () => [
          {
            id: "send-anchor",
            sessionID: "running",
            type: "user",
            time: { created: 1 },
            payload: { text: "Requested work" },
            delivery: "queue",
          },
        ],
      },
    });
    Object.assign(f.client.permission, {
      list: async () => [],
      get: async () => ({ id: "request", sessionID: "running" }),
      saved: { list: async () => [] },
    });
    for (const [name, query] of [
      ["read_session_messages", { order: "asc" }],
      ["read_session_message", { messageID: "idle-1" }],
      ["read_session_context", {}],
      ["read_session_diff", {}],
      ["read_session_inbox", {}],
      ["list_session_permissions", {}],
      ["get_session_permission", { requestID: "request" }],
      ["list_saved_permissions", {}],
      ["list_session_forms", {}],
      ["get_session_form", { formID: "form" }],
      ["list_session_instructions", {}],
      ["read_session_stats", { toolsLevel: "summary" }],
      ["export_session", {}],
    ] as const) {
      expect((await f.call(name, { ...target, ...query })).available).toBe(
        true,
      );
    }
    const first = await f.call("read_session_messages", target);
    expect(typeof first.cursor).toBe("string");
    for (const caller of [
      {
        ...f.context,
        sessionID: "another-coordinator" as ToolContext["sessionID"],
      },
      { ...f.context, agent: "another-agent" as ToolContext["agent"] },
    ])
      await expect(
        f.call(
          "read_session_messages",
          { ...target, cursor: first.cursor },
          caller,
        ),
      ).rejects.toThrow();
    expect(
      await f.call("follow_session", { ...target, sendID: "send-anchor" }),
    ).toMatchObject({
      available: true,
      sendID: "send-anchor",
      anchor: "pending",
    });
    f.registry.dispose();
  });
  it("Rejects invalid or unavailable content continuation", async () => {
    const f = fixture();
    let reads = 0;
    f.port.native.read = async () => {
      reads++;
      throw new Error("Unexpected native read");
    };
    for (const query of [
      { extra: true },
      { order: "invalid" },
      { toolsLevel: "invalid" },
      { limit: 1.5 },
      { location: "relative/project" },
    ])
      await expect(
        f.call("read_session_messages", {
          sessionID: "running",
          location: "/projects/one",
          ...query,
        }),
      ).rejects.toThrow();
    expect(reads).toBe(0);
    f.registry.dispose();
  });
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
    await expect(
      f.call("list_sessions", { taskIDs: ["task"] }),
    ).rejects.toThrow("Unknown input field");
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
    await expect(
      f.call("list_sessions", { taskIDs: ["task"] }),
    ).rejects.toThrow("Unknown input field");
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

  it("Bounds candidate reads before status hydration", async () => {
    for (const { query, expected, hydrated } of [
      { query: { limit: 1 }, expected: ["running"], hydrated: ["running"] },
      { query: { limit: 2, agent: "other" }, expected: [], hydrated: [] },
      {
        query: { limit: 1, statuses: ["inactive"] },
        expected: [],
        hydrated: ["running"],
      },
    ]) {
      const f = fixture();
      const reads: string[] = [];
      f.client.session.list = async (input) => {
        f.queries.push(input);
        return {
          data: f.rows.slice(0, input?.limit),
          cursor: { next: "next-native" },
        };
      };
      const get = f.client.session.get;
      f.client.session.get = async (input) => {
        reads.push(input.sessionID);
        return get(input);
      };
      const result = await f.call("list_sessions", query);
      expect(f.queries).toHaveLength(1);
      expect(f.queries[0]).toHaveProperty("limit", query.limit);
      expect(reads).toEqual(hydrated);
      expect(
        (result.sessions as { id: string }[]).map((row) => row.id),
      ).toEqual(expected);
      expect(result.cursor).toEqual(expect.any(String));
      f.registry.dispose();
    }
    const f = fixture();
    f.client.session.get = async () => ({
      ...f.rows[0]!,
      parentID: "new-parent",
    });
    expect(
      (
        (await f.call("list_sessions", { statuses: ["running", "unknown"] }))
          .sessions as { id: string }[]
      ).some((row) => row.id === "running"),
    ).toBe(false);
    f.registry.dispose();
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
    ).toMatchObject({ sessions: [{ id: "next" }], partial: false });
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

  it("Filters by update and creation time", async () => {
    const f = fixture();
    f.rows.splice(0);
    for (const [id, created, updated] of [
      ["old", 1_000, 2_000],
      ["mid", 3_000, 4_000],
      ["new", 5_000, 6_000],
    ] as const)
      f.rows.push({
        id,
        title: id,
        projectID: "project",
        agent: "engineer",
        location: { directory: "/projects/one" },
        time: { created, updated },
      } as SessionInfo);
    const hydrated: string[] = [];
    const get = f.client.session.get;
    f.client.session.get = async (input) => {
      hydrated.push(input.sessionID);
      return get(input);
    };
    const ids = async (input: Record<string, unknown>) =>
      ((await f.call("list_sessions", input)).sessions as { id: string }[]).map(
        (row) => row.id,
      );
    expect(await ids({ updatedAfter: 4_000 })).toEqual(["mid", "new"]);
    expect(await ids({ updatedBefore: 4_000 })).toEqual(["old"]);
    expect(await ids({ createdAfter: 3_000, createdBefore: 5_000 })).toEqual([
      "mid",
    ]);
    hydrated.length = 0;
    expect(await ids({ updatedAfter: new Date(4_000).toISOString() })).toEqual([
      "mid",
      "new",
    ]);
    expect(hydrated.sort()).toEqual(["mid", "new"]);
    expect(await ids({ updatedAfter: "1970-01-01T01:00:04+01:00" })).toEqual([
      "mid",
      "new",
    ]);
    expect(await ids({ updatedAfter: "1970-01-01" })).toEqual([
      "old",
      "mid",
      "new",
    ]);
    for (const bad of ["yesterday", "1970-01-01T00:00:04", -1, 1.5, true])
      await expect(ids({ updatedBefore: bad })).rejects.toThrow("time");
  });

  it("Stops scanning once no later session can match", async () => {
    const stopping = [
      { order: "desc", bound: { updatedAfter: 4_000 } },
      { order: "asc", bound: { updatedBefore: 4_000 } },
    ] as const;
    for (const { order, bound } of stopping) {
      const f = fixture();
      f.rows.splice(0);
      for (const [id, updated] of [
        ["a", order === "desc" ? 5_000 : 1_000],
        ["b", order === "desc" ? 3_000 : 5_000],
      ] as const)
        f.rows.push({
          id,
          title: id,
          projectID: "project",
          agent: "engineer",
          location: { directory: "/projects/one" },
          time: { created: 1, updated },
        } as SessionInfo);
      f.cursor("more-native-pages");
      const result = await f.call("list_sessions", { order, ...bound });
      expect(result.cursor).toBeUndefined();
      expect(result.partial).toBe(false);
    }
    const f = fixture();
    f.cursor("more-native-pages");
    expect((await f.call("list_sessions", { updatedAfter: 0 })).cursor).toEqual(
      expect.any(String),
    );
  });

  it("Filters by project subpath", async () => {
    const f = fixture();
    f.cursor("more");
    const first = await f.call("list_sessions", {
      projectID: "project",
      subpath: "packages/app",
      limit: 1,
    });
    const cursor = first.cursor;
    expect(f.queries[0]).toMatchObject({
      project: "project",
      subpath: "packages/app",
    });
    await expect(
      f.call("list_sessions", {
        projectID: "project",
        subpath: "packages/web",
        limit: 1,
        cursor,
      }),
    ).rejects.toThrow("Continuation");
    await expect(
      f.call("list_sessions", { subpath: "packages/app" }),
    ).rejects.toThrow("projectID");
    for (const bad of ["/abs", "../up", "", "a/", "./a", "a//b"])
      await expect(
        f.call("list_sessions", { projectID: "project", subpath: bad }),
      ).rejects.toThrow();
  });

  it("Lists metadata without status hydration", async () => {
    const f = fixture();
    let reads = 0;
    f.client.session.get = async () => {
      reads++;
      throw new Error("must not hydrate");
    };
    f.client.session.active = async () => {
      reads++;
      return {};
    };
    f.cursor("more");
    const first = await f.call("list_sessions", { hydrate: false, limit: 2 });
    const cursor = first.cursor;
    expect(reads).toBe(0);
    expect(first).toMatchObject({
      sessions: [
        { id: "running", status: "unknown" },
        { id: "inactive", status: "unknown" },
      ],
      unknownCount: 0,
      cursor: expect.any(String),
    });
    await expect(
      f.call("list_sessions", { hydrate: false, statuses: ["running"] }),
    ).rejects.toThrow("hydrate");
    await expect(f.call("list_sessions", { limit: 2, cursor })).rejects.toThrow(
      "Continuation",
    );
    expect(
      await f.call("list_sessions", { hydrate: false, limit: 2, cursor }),
    ).toMatchObject({
      sessions: [{ id: "unknown", status: "unknown" }],
      unknownCount: 0,
    });
    expect(reads).toBe(0);
  });

  it("Defers rows when the hydration budget is spent", async () => {
    const manyRows = (f: ReturnType<typeof fixture>) => {
      f.rows.splice(0);
      for (let index = 0; index < 20; index++)
        f.rows.push({
          id: `r${index}`,
          title: `r${index}`,
          projectID: "project",
          agent: "engineer",
          location: { directory: "/projects/one" },
          time: { created: 1, updated: 1 },
        } as SessionInfo);
    };
    const spent = new AbortController();
    spent.abort();
    const setBudget = (
      f: ReturnType<typeof fixture>,
      budget: () => AbortSignal,
    ) => {
      (f.port as { hydrationBudget?: () => AbortSignal }).hydrationBudget =
        budget;
    };
    const f = fixture();
    manyRows(f);
    setBudget(f, () => spent.signal);
    const first = await f.call("list_sessions", {});
    const cursor = first.cursor;
    expect(first).toMatchObject({
      partial: true,
      unknownCount: 0,
      cursor: expect.any(String),
    });
    const firstIds = (first.sessions as { id: string; status: string }[]).map(
      (row) => row.id,
    );
    expect(firstIds.length).toBeGreaterThanOrEqual(1);
    expect(firstIds.length).toBeLessThan(20);
    expect(
      (first.sessions as { status: string }[]).every(
        (row) => row.status === "inactive",
      ),
    ).toBe(true);
    setBudget(f, () => new AbortController().signal);
    const second = await f.call("list_sessions", { cursor });
    expect(second.cursor).toBeUndefined();
    expect([
      ...firstIds,
      ...(second.sessions as { id: string }[]).map((r) => r.id),
    ]).toEqual(f.rows.map((row) => row.id));

    const filtered = fixture();
    manyRows(filtered);
    filtered.client.session.active = async () =>
      ({ r19: { type: "running" } }) as never;
    setBudget(filtered, () => spent.signal);
    const page1 = await filtered.call("list_sessions", {
      statuses: ["running"],
    });
    const cursor1 = page1.cursor;
    const page2 = await filtered.call("list_sessions", {
      statuses: ["running"],
      cursor: cursor1,
    });
    const cursor2 = page2.cursor;
    expect(page1.sessions).toEqual([]);
    expect(page2.sessions).toEqual([]);
    expect(cursor2).toEqual(expect.any(String));
    setBudget(filtered, () => new AbortController().signal);
    const page3 = await filtered.call("list_sessions", {
      statuses: ["running"],
      cursor: cursor2,
    });
    expect(page3).toMatchObject({
      sessions: [{ id: "r19", status: "running" }],
    });
    expect(page3.cursor).toBeUndefined();

    const overrun = fixture();
    manyRows(overrun);
    const during = new AbortController();
    setBudget(overrun, () => during.signal);
    const get = overrun.client.session.get;
    overrun.client.session.get = async (input) => {
      if (input.sessionID === "r8") during.abort();
      return get(input);
    };
    const page = await overrun.call("list_sessions", {});
    expect((page.sessions as { id: string }[]).map((row) => row.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `r${index}`),
    );
    expect(page.cursor).toEqual(expect.any(String));
  });

  it("Retries a continuation after a timeout", async () => {
    for (const classification of ["timeout", "cancelled"] as const) {
      const f = fixture();
      const read = f.port.native.read;
      const first = await f.call("list_sessions", { limit: 1 });
      const cursor = first.cursor;
      expect(cursor).toEqual(expect.any(String));
      f.port.native.read = async () => {
        throw new NativeConnectionError(
          "Native service failed",
          classification,
        );
      };
      f.advance(200_000);
      await expect(
        f.call("list_sessions", { limit: 1, cursor }),
      ).rejects.toThrow("failed");
      f.port.native.read = read;
      expect(await f.call("list_sessions", { limit: 1, cursor })).toMatchObject(
        { sessions: [{ id: "inactive" }] },
      );
      f.advance(100_001);
      await expect(
        f.call("list_sessions", { limit: 1, cursor }),
      ).rejects.toThrow("Continuation");
    }
  });

  it("Discards continuations after disposal or identity failure", async () => {
    const f = fixture();
    const read = f.port.native.read;
    const first = await f.call("list_sessions", { limit: 1 });
    f.port.native.read = async () => {
      throw new NativeConnectionError(
        "Native service registration unavailable",
      );
    };
    await expect(
      f.call("list_sessions", { limit: 1, cursor: first.cursor }),
    ).rejects.toThrow("registration");
    f.port.native.read = read;
    await expect(
      f.call("list_sessions", { limit: 1, cursor: first.cursor }),
    ).rejects.toThrow("Continuation");
  });

  it("Lists enabled models with variants", async () => {
    const f = fixture();
    expect(
      await f.call("list_models", { location: "/projects/one" }),
    ).toMatchObject({
      location: "/projects/one",
      models: [
        {
          providerID: "anthropic",
          id: "sonnet",
          name: "Sonnet",
          status: "active",
          variants: ["high"],
        },
      ],
    });
  });

  it("Rejects a mismatched location", async () => {
    const f = fixture();
    await expect(
      f.call("list_models", { location: "/projects/two" }),
    ).rejects.toThrow("does not match");
    const oversized = fixture();
    const list = oversized.client.model.list;
    oversized.client.model.list = async (input) => {
      const result = await list(input);
      return {
        ...result,
        data: Array.from({ length: 201 }, () => result.data[0]!),
      };
    };
  });

  it("Lists catalogs beyond two hundred rows", async () => {
    const oversized = fixture();
    const list = oversized.client.model.list;
    oversized.client.model.list = async (input) => {
      const result = await list(input);
      return {
        ...result,
        data: Array.from({ length: 201 }, () => result.data[0]!),
      };
    };
    const result = (await oversized.call("list_models", {
      location: "/projects/one",
    })) as { models: unknown[] };
    expect(result.models).toHaveLength(201);
  });

  it("Creates an assignment through separate catalog and mutation calls", async () => {
    const f = fixture();
    expect(await f.call("list_projects")).toMatchObject({
      projects: [{ projectID: "project", location: "/projects/one" }],
    });
    expect(
      await f.call("list_agents", { location: "/projects/one" }),
    ).toMatchObject({ agents: ["engineer"] });
    expect(await f.call("list_followed_sessions")).toMatchObject({
      sessions: [{ sessionID: "running" }],
    });
    const send = {
      sessionID: "worker",
      location: "/projects/one",
      agent: "engineer",
      text: "Requested work",
    };
    expect(await f.call("send_session", send)).toMatchObject({
      sendID: "msg_native",
      status: "admitted",
    });
    expect(f.controls.at(-1)).toMatchObject([
      "send_session",
      send,
      expect.objectContaining({ sessionID: "coordinator" }),
    ]);
    for (const [kind, options] of [
      ["synthetic", { resume: false }],
      ["shell", {}],
      ["compact", { delivery: "queue" }],
      ["command", { name: "review" }],
      ["skill", { skillID: "coding" }],
    ] as const) {
      const { text, ...target } = send;
      expect(
        (
          await f.call(`${kind}_session`, {
            ...target,
            ...(kind === "compact" || kind === "skill" ? {} : { text }),
            options,
          })
        ).status,
      ).toBe("admitted");
      expect(f.controls.at(-1)).toMatchObject([
        "send_session",
        {
          ...target,
          text: kind === "compact" || kind === "skill" ? kind : text,
          kind,
          options,
        },
        expect.objectContaining({ sessionID: "coordinator" }),
      ]);
    }
    for (const [operation, payload] of [
      ["reply_permission", { requestID: "permission", decision: "reject" }],
      ["reply_form", { formID: "form", answer: { selected: "" } }],
      ["request_permission", { action: "shell", resources: ["make test"] }],
      ["remove_saved_permission", { id: "saved" }],
      ["interrupt_session", { resume: false }],
    ] as const) {
      const target = {
        sessionID: send.sessionID,
        location: send.location,
        agent: send.agent,
      };
      expect(await f.call(operation, { ...target, ...payload })).toEqual({
        status: "completed",
      });
      expect(f.controls.at(-1)).toMatchObject([
        "session_operation",
        { operation, ...target, payload },
        expect.objectContaining({ sessionID: "coordinator" }),
      ]);
    }
    for (const [name, input, expected] of [
      [
        "create_session",
        { location: "/projects/one", agent: "engineer" },
        ["create", { location: "/projects/one", agent: "engineer" }],
      ],
      ["adopt_session", { sessionID: "worker" }, ["adopt", "worker"]],
    ] as const) {
      expect(await f.call(name, input)).toMatchObject({ following: true });
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
    expect(
      await f.call("stop_following", { sessionID: "worker" }),
    ).toMatchObject({ following: false });
    expect(f.controls.at(-1)).toMatchObject([
      "stop",
      "worker",
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
  });
});
