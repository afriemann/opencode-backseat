import type { Info, ToolContext } from "@opencode/plugin/promise/tool";
import type { NativeConnection } from "./native-connection.ts";
import type { NativeBackend } from "./server.ts";
import {
  NativeDiscovery,
  readNativeInventory,
  refreshNativeSessions,
  type NativeInventory,
} from "./native-sessions.ts";
import { exact, integer, list, object, text, fingerprint } from "./state.ts";

export const COORDINATION_TOOLS = [
  "list_sessions",
  "list_projects",
  "list_agents",
  "list_tasks",
  "get_task",
  "create_session",
  "adopt_session",
  "take_over_task",
  "dispatch_task",
  "hold_task",
  "share_context",
  "recover_runtime",
  "delete_session",
] as const;
export const COORDINATOR_TOOL_IDS = new Set([
  "execute",
  "question",
  ...COORDINATION_TOOLS.map((name) => `conman_${name}`),
]);
export interface CoordinationToolPort {
  native: NativeConnection;
  backend: Pick<
    NativeBackend,
    | "inspect"
    | "inspectDeletions"
    | "nativeControl"
    | "recover"
    | "deleteSession"
  >;
  canonical(location: string): Promise<string>;
  authorize(context: ToolContext): Promise<void>;
  signal: AbortSignal;
  now?: () => number;
}
const PAGE_TTL = 5 * 60_000;
const PAGE_CAPACITY = 128;
const SESSION_STATUSES = ["running", "waiting", "inactive", "unknown"] as const;
const TASK_STATUSES = ["active", "held", "manual", "complete"] as const;
const stringSchema = { type: "string", minLength: 1 } as const;
const stringsSchema = {
  type: "array",
  items: stringSchema,
  minItems: 1,
  maxItems: 200,
} as const;
const taskSchema = inputSchema(
  {
    id: stringSchema,
    title: stringSchema,
    goal: stringSchema,
    criteria: stringsSchema,
    constraints: { type: "array", items: stringSchema },
    scope: stringsSchema,
    location: stringSchema,
    agent: stringSchema,
    group: stringSchema,
  },
  [
    "id",
    "title",
    "goal",
    "criteria",
    "constraints",
    "scope",
    "location",
    "agent",
  ],
);
const rowSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    title: stringSchema,
    projectID: stringSchema,
    location: stringSchema,
    agent: stringSchema,
    parentID: { anyOf: [stringSchema, { type: "null" }] },
    topLevel: { type: "boolean" },
    archived: { type: "boolean" },
    status: { enum: SESSION_STATUSES },
  },
  required: [
    "id",
    "title",
    "projectID",
    "location",
    "parentID",
    "topLevel",
    "archived",
    "status",
  ],
  additionalProperties: false,
};
const outputSchemas: Record<
  (typeof COORDINATION_TOOLS)[number],
  Record<string, unknown>
> = {
  list_sessions: {
    type: "object",
    properties: {
      available: { type: "boolean" },
      partial: { type: "boolean" },
      unknownCount: { type: "integer" },
      cursor: stringSchema,
      reason: stringSchema,
      sessions: { type: "array", items: rowSchema },
    },
    required: ["available", "partial", "unknownCount", "sessions"],
  },
  list_projects: {
    type: "object",
    properties: {
      projects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: stringSchema,
            projectID: stringSchema,
            title: stringSchema,
            location: stringSchema,
          },
          required: ["id", "projectID", "title", "location"],
        },
      },
    },
    required: ["projects"],
  },
  list_agents: {
    type: "object",
    properties: {
      location: stringSchema,
      agents: { type: "array", items: stringSchema },
    },
    required: ["location", "agents"],
  },
  list_tasks: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: stringSchema,
            workerID: stringSchema,
            title: stringSchema,
            location: stringSchema,
            status: { enum: TASK_STATUSES },
          },
          additionalProperties: true,
        },
      },
    },
    required: ["tasks"],
  },
  get_task: {
    type: "object",
    properties: {
      task: { type: "object", additionalProperties: true },
      intents: { type: "array", items: { type: "object" } },
      completions: { type: "array", items: { type: "object" } },
      snapshots: { type: "array", items: { type: "object" } },
      deletions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sessionID: stringSchema,
            status: { enum: ["pending", "deleted", "uncertain"] },
            affectedTasks: { type: "array", items: stringSchema },
            observations: {
              type: "array",
              items: inputSchema(
                {
                  sessionID: stringSchema,
                  status: { enum: ["present", "absent", "unknown"] },
                },
                ["sessionID", "status"],
              ),
            },
          },
          required: ["sessionID", "status", "affectedTasks", "observations"],
        },
      },
    },
    required: ["task", "intents", "completions", "snapshots", "deletions"],
  },
  create_session: { type: "object", additionalProperties: true },
  adopt_session: { type: "object", additionalProperties: true },
  take_over_task: { type: "object", additionalProperties: true },
  dispatch_task: { type: "object", additionalProperties: true },
  hold_task: { type: "object", additionalProperties: true },
  share_context: { type: "object", additionalProperties: true },
  recover_runtime: { type: "object", additionalProperties: true },
  delete_session: {
    type: "object",
    properties: {
      sessionID: stringSchema,
      status: { enum: ["deleted", "uncertain"] },
      affectedTasks: { type: "array", items: stringSchema },
    },
    required: ["sessionID", "status", "affectedTasks"],
  },
};
type Row = NativeInventory["sessions"][number];
interface Continuation {
  caller: string;
  query: string;
  expires: number;
  nativeCursor?: string;
  rows: Row[];
  degraded: boolean;
}
function selection(value: unknown, allowed?: readonly string[]): string[] {
  const result = [...new Set(list(value, text))].sort();
  if (
    !result.length ||
    result.length > 200 ||
    result.some(
      (item) => item.length > 256 || (allowed && !allowed.includes(item)),
    )
  )
    throw new Error("Invalid filter selection");
  return result;
}
function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const result = text(value);
  if (result.length > 4096) throw new Error("Oversized query value");
  return result;
}
function inputSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return { type: "object", properties, required, additionalProperties: false };
}

export function createCoordinationTools(port: CoordinationToolPort): {
  tools: Info[];
  dispose(): void;
} {
  const pages = new Map<string, Continuation>();
  const incarnation = process.hrtime.bigint().toString(10);
  let sequence = 0,
    disposed = false;
  const now = port.now ?? Date.now;
  const alive = (context: ToolContext) => {
    if (disposed || port.signal.aborted)
      throw new Error("Project adapter is unavailable");
    context.signal.throwIfAborted();
  };
  const owned = async (context: ToolContext) => {
    const snapshot = await port.backend.inspect(context);
    if (snapshot.authority !== "owned")
      throw new Error("Owned task store required for this query");
    return snapshot;
  };
  const canonical = async (value: unknown) => {
    const location = text(value);
    if (
      !location.startsWith("/") ||
      (await port.canonical(location)) !== location
    )
      throw new Error("Select an absolute canonical project location");
    return location;
  };
  const native = async <T>(
    context: ToolContext,
    operation: Parameters<NativeConnection["read"]>[0],
  ): Promise<T> => {
    try {
      return (await port.native.read((client, signal) =>
        operation(
          client,
          AbortSignal.any([signal, port.signal, context.signal]),
        ),
      )) as T;
    } catch (error) {
      pages.clear();
      throw error;
    }
  };
  const remember = (page: Continuation): string => {
    for (const [id, stored] of pages)
      if (stored.expires <= now()) pages.delete(id);
    while (pages.size >= PAGE_CAPACITY)
      pages.delete(pages.keys().next().value!);
    const id = `page-${incarnation}-${++sequence}`;
    pages.set(id, page);
    return id;
  };
  const sessions = async (v: Record<string, unknown>, context: ToolContext) => {
    exact(v, [
      "statuses",
      "projectID",
      "location",
      "taskIDs",
      "agent",
      "search",
      "parentID",
      "includeArchived",
      "limit",
      "cursor",
      "order",
    ]);
    const statuses =
      v.statuses === undefined
        ? ["inactive", "running", "waiting"]
        : selection(v.statuses, SESSION_STATUSES);
    const taskIDs = v.taskIDs === undefined ? undefined : selection(v.taskIDs);
    const snapshot = taskIDs ? await owned(context) : undefined;
    const workers = snapshot
      ? snapshot.bindings
          .filter((b) => taskIDs!.includes(b.id))
          .map((b) => b.workerID)
          .sort()
      : undefined;
    const location =
      v.location === undefined ? undefined : await canonical(v.location);
    const projectID = optionalText(v.projectID),
      agent = optionalText(v.agent),
      search = optionalText(v.search);
    const parentID = v.parentID === null ? null : optionalText(v.parentID);
    if (
      v.includeArchived !== undefined &&
      typeof v.includeArchived !== "boolean"
    )
      throw new Error("Invalid archive selection");
    const includeArchived = v.includeArchived === true;
    const limit = v.limit === undefined ? 50 : integer(v.limit, 1);
    if (limit > 200) throw new Error("Session limit exceeds 200");
    const order = v.order ?? "desc";
    if (order !== "asc" && order !== "desc")
      throw new Error("Invalid session order");
    const query = {
      statuses,
      projectID,
      location,
      taskIDs,
      workers,
      agent,
      search,
      parentID,
      includeArchived,
      limit,
      order,
    };
    const normalized = fingerprint(query),
      caller = JSON.stringify([context.sessionID, context.agent]);
    const id = v.cursor === undefined ? undefined : text(v.cursor);
    const previous = id ? pages.get(id) : undefined;
    if (
      id &&
      (!previous ||
        previous.caller !== caller ||
        previous.query !== normalized ||
        previous.expires <= now())
    )
      throw new Error(
        "Continuation unavailable or query changed; restart listing",
      );
    const expires = previous?.expires ?? now() + PAGE_TTL;
    const buffered = previous?.rows ?? [];
    let rows = buffered,
      next = previous?.nativeCursor,
      degraded = previous?.degraded ?? false;
    let unknownCount = buffered.filter(
      (row) => row.status === "unknown",
    ).length;
    if (!buffered.length && (!previous || next)) {
      const page = await native<NativeInventory>(context, (client, signal) =>
        readNativeInventory(client, next, signal, {
          ...(projectID ? { projectID } : {}),
          ...(location ? { location } : {}),
          ...(search ? { search } : {}),
          ...(parentID !== undefined ? { parentID } : {}),
          includeArchived,
          order,
        }),
      );
      if (!page.available)
        return {
          available: false,
          partial: true,
          reason: page.reason,
          sessions: [],
          unknownCount: 0,
        };
      unknownCount = page.sessions.filter(
        (row) => row.status === "unknown",
      ).length;
      degraded = degraded || unknownCount > 0;
      next = page.cursor;
      if (previous?.nativeCursor && next === previous.nativeCursor)
        throw new Error("Continuation did not advance; restart listing");
      rows = page.sessions;
    } else if (previous) {
      rows = await native<Row[]>(context, (client, signal) =>
        refreshNativeSessions(client, buffered, signal),
      );
      unknownCount = rows.filter((row) => row.status === "unknown").length;
      degraded = degraded || unknownCount > 0;
    }
    rows = rows.filter(
      (row) =>
        statuses.includes(
          row.status === "waiting-for-input" ? "waiting" : row.status,
        ) &&
        (!projectID || row.projectID === projectID) &&
        (!location || row.location === location) &&
        (!agent || row.agent === agent) &&
        (!workers || workers.includes(row.id)) &&
        (parentID === undefined || row.parentID === parentID) &&
        (includeArchived || !row.archived),
    );
    const result = rows.slice(0, limit),
      remaining = rows.slice(limit);
    alive(context);
    const cursor =
      remaining.length || next
        ? remember({
            caller,
            query: normalized,
            expires,
            ...(next ? { nativeCursor: next } : {}),
            rows: remaining,
            degraded,
          })
        : undefined;
    return {
      available: true,
      partial: Boolean(cursor) || degraded,
      unknownCount,
      sessions: result.map((row) => ({
        ...row,
        status: row.status === "waiting-for-input" ? "waiting" : row.status,
      })),
      ...(cursor ? { cursor } : {}),
    };
  };
  const tasks = async (
    v: Record<string, unknown>,
    context: ToolContext,
    single = false,
  ) => {
    exact(
      v,
      single
        ? ["taskID"]
        : ["statuses", "location", "group", "workerID", "taskIDs", "search"],
    );
    const snapshot = await owned(context);
    if (single) {
      const id = text(v.taskID),
        task = snapshot.bindings.find((b) => b.id === id);
      if (!task) throw new Error("Unknown task");
      return {
        task,
        intents: snapshot.intents.filter((i) => i.intent.taskID === id),
        completions: snapshot.completions.filter((c) => c.taskID === id),
        snapshots: snapshot.snapshots.filter((s) => s.recipients.includes(id)),
        deletions: await port.backend.inspectDeletions(id, context),
      };
    }
    const statuses =
      v.statuses === undefined
        ? TASK_STATUSES
        : selection(v.statuses, TASK_STATUSES);
    const ids = v.taskIDs === undefined ? undefined : selection(v.taskIDs);
    const location = optionalText(v.location),
      group = optionalText(v.group),
      workerID = optionalText(v.workerID),
      search = optionalText(v.search)?.toLowerCase();
    return {
      tasks: snapshot.bindings.filter(
        (b) =>
          statuses.includes(b.status) &&
          (!ids || ids.includes(b.id)) &&
          (!location || location === b.location) &&
          (!group || group === b.group) &&
          (!workerID || workerID === b.workerID) &&
          (!search ||
            `${b.id} ${b.title} ${b.goal}`.toLowerCase().includes(search)),
      ),
    };
  };
  const specs: Record<
    (typeof COORDINATION_TOOLS)[number],
    {
      description: string;
      input: ReturnType<typeof inputSchema>;
      run(v: Record<string, unknown>, context: ToolContext): Promise<unknown>;
    }
  > = {
    list_sessions: {
      description:
        "List native session metadata and hierarchy across projects. Combine statuses (running, waiting, inactive, unknown); default excludes unknown. Filter projectID, canonical location, taskIDs, agent, native service search, parentID (null means roots), archive inclusion and order. limit is 1..200 returned rows; each call scans at most 200 native rows. Continue with the short cursor and identical filters even after an empty partial page. Unknown counts and partial results are not completion. Task filters require the owned task store.",
      input: inputSchema({
        statuses: {
          type: "array",
          items: { enum: SESSION_STATUSES },
          minItems: 1,
        },
        projectID: stringSchema,
        location: stringSchema,
        taskIDs: stringsSchema,
        agent: stringSchema,
        search: stringSchema,
        parentID: { anyOf: [stringSchema, { type: "null" }] },
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        cursor: stringSchema,
        order: { enum: ["asc", "desc"] },
      }),
      run: sessions,
    },
    list_projects: {
      description:
        "List native project locations without requiring task-store or TUI authority.",
      input: inputSchema({}),
      async run(v, context) {
        exact(v, []);
        return {
          projects: await native(context, (client, signal) =>
            new NativeDiscovery(client, signal).projects(),
          ),
        };
      },
    },
    list_agents: {
      description:
        "List eligible non-coordinator worker agents at a canonical location.",
      input: inputSchema({ location: stringSchema }, ["location"]),
      async run(v, context) {
        exact(v, ["location"]);
        const location = await canonical(v.location);
        return {
          location,
          agents: await native(context, (client, signal) =>
            new NativeDiscovery(client, signal).agents(location),
          ),
        };
      },
    },
    list_tasks: {
      description:
        "List protected task bindings filtered by task statuses, location, group, workerID, taskIDs or title/goal search. Requires owned task storage.",
      input: inputSchema({
        statuses: {
          type: "array",
          items: { enum: TASK_STATUSES },
          minItems: 1,
        },
        location: stringSchema,
        group: stringSchema,
        workerID: stringSchema,
        taskIDs: stringsSchema,
        search: stringSchema,
      }),
      run: tasks,
    },
    get_task: {
      description:
        "Read one protected task, delivery identities, completion records, shared context and retained deletion outcomes with current native presence evidence. Observed absence never converts uncertain deletion into success or proves non-delivery.",
      input: inputSchema({ taskID: stringSchema }, ["taskID"]),
      run: (v, context) => tasks(v, context, true),
    },
    create_session: {
      description:
        "Create a native worker and deliver its confirmed task immediately. Requires operation-specific native approval.",
      input: inputSchema({ task: taskSchema }, ["task"]),
      async run(v, context) {
        exact(v, ["task"]);
        const task = object(v.task);
        return port.backend.nativeControl(
          "create",
          text(task.id),
          task,
          context,
        );
      },
    },
    adopt_session: {
      description:
        "Bind a selected top-level session to an approved task without prompting or changing its agent. Child sessions are rejected before and after native approval.",
      input: inputSchema({ task: taskSchema, sessionID: stringSchema }, [
        "task",
        "sessionID",
      ]),
      async run(v, context) {
        exact(v, ["task", "sessionID"]);
        const task = object(v.task);
        return port.backend.nativeControl(
          "adopt",
          text(task.id),
          { goal: task, workerID: text(v.sessionID) },
          context,
        );
      },
    },
    take_over_task: {
      description:
        "Take manual control of a bound top-level worker and fence automatic follow-ups without sending a prompt.",
      input: inputSchema({ taskID: stringSchema }, ["taskID"]),
      async run(v, context) {
        exact(v, ["taskID"]);
        return port.backend.nativeControl(
          "takeover",
          text(v.taskID),
          {},
          context,
        );
      },
    },
    dispatch_task: {
      description:
        "Send explicitly requested text to a held/manual task. scope must be a nonempty declared subset of approved scope. Native approval binds the exact payload. Never answers pending asks or silently retries uncertain delivery.",
      input: inputSchema(
        { taskID: stringSchema, text: stringSchema, scope: stringsSchema },
        ["taskID", "text", "scope"],
      ),
      async run(v, context) {
        exact(v, ["taskID", "text", "scope"]);
        return port.backend.nativeControl(
          "dispatch",
          text(v.taskID),
          { text: text(v.text), scope: list(v.scope, text) },
          context,
        );
      },
    },
    hold_task: {
      description:
        "Hold a task and invalidate automatic decisions while preserving all counters and delivery records.",
      input: inputSchema({ taskID: stringSchema }, ["taskID"]),
      async run(v, context) {
        exact(v, ["taskID"]);
        return port.backend.nativeControl("hold", text(v.taskID), {}, context);
      },
    },
    share_context: {
      description:
        "Publish approved shared context and select exact shared versions for one task. An empty shared list revokes future inputs only.",
      input: inputSchema(
        {
          taskID: stringSchema,
          snapshot: inputSchema(
            {
              id: stringSchema,
              version: { type: "integer", minimum: 1 },
              group: stringSchema,
              content: stringSchema,
              recipients: stringsSchema,
            },
            ["id", "version", "group", "content", "recipients"],
          ),
          shared: {
            type: "array",
            items: inputSchema(
              { id: stringSchema, version: { type: "integer", minimum: 1 } },
              ["id", "version"],
            ),
          },
        },
        ["taskID", "shared"],
      ),
      async run(v, context) {
        exact(v, ["taskID", "snapshot", "shared"]);
        return port.backend.nativeControl(
          "share",
          text(v.taskID),
          {
            ...(v.snapshot === undefined ? {} : { snapshot: v.snapshot }),
            shared: v.shared,
          },
          context,
        );
      },
    },
    recover_runtime: {
      description:
        "Recover a terminated runtime owner through native approval. Does not arm optional automation.",
      input: inputSchema({}),
      async run(v, context) {
        exact(v, []);
        return port.backend.recover(
          { coordinatorID: context.sessionID },
          context,
          context.signal,
        );
      },
    },
    delete_session: {
      description:
        "Delete a native session and its native recursive subtree, stopping active execution. Approval covers concurrent descendants, not an atomic pre-enumerated set. Rejects the invoking coordinator and its ancestors. Retains task history and uncertain deliveries; never retries an uncertain deletion.",
      input: inputSchema({ sessionID: stringSchema }, ["sessionID"]),
      async run(v, context) {
        exact(v, ["sessionID"]);
        return port.backend.deleteSession(text(v.sessionID), context);
      },
    },
  };
  return {
    tools: COORDINATION_TOOLS.map((name): Info => ({
      name,
      description: specs[name].description,
      input: specs[name].input,
      output: outputSchemas[name],
      options: { namespace: "conman", codemode: true },
      async execute(input: unknown, context) {
        alive(context);
        await port.authorize(context);
        alive(context);
        const output = await specs[name].run(object(input), {
          ...context,
          signal: AbortSignal.any([port.signal, context.signal]),
        });
        alive(context);
        return { output };
      },
    })),
    dispose() {
      disposed = true;
      pages.clear();
    },
  };
}
