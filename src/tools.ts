import type { Info, ToolContext } from "@opencode/plugin/promise/tool";
import {
  diagnosticContext,
  type NativeConnection,
  type DiagnosticEmitter,
  type DiagnosticContext,
} from "./native-connection.ts";
import type { NativeBackend } from "./server.ts";
import {
  CONTENT_READERS,
  CONTENT_READER_NAMES,
  createNativeContent,
  parseContentQuery,
} from "./native-content.ts";
import {
  NATIVE_OPERATIONS,
  NATIVE_OPERATION_NAMES,
  NATIVE_SEND_DESCRIPTIONS,
  NATIVE_SEND_OPTIONS,
  type NativeSendKind,
} from "./native-operations.ts";
import {
  NativeDiscovery,
  readNativeInventory,
  refreshNativeSessions,
  type NativeInventory,
} from "./native-sessions.ts";
import { exact, integer, list, object, text, fingerprint } from "./state.ts";

const CORE_COORDINATION_TOOLS = [
  "list_sessions",
  "list_projects",
  "list_agents",
  "list_tasks",
  "get_task",
  "create_session",
  "adopt_session",
  "take_over_task",
  "dispatch_task",
  "send_session",
  "hold_task",
  "start_supervision",
  "resume_task",
  "share_context",
  "recover_runtime",
  "delete_session",
] as const;
export const COORDINATION_TOOLS = [
  ...CORE_COORDINATION_TOOLS,
  ...NATIVE_OPERATION_NAMES,
  ...CONTENT_READER_NAMES,
  ...Object.keys(NATIVE_SEND_DESCRIPTIONS).map((kind) => `${kind}_session`),
] as const;
export const COORDINATOR_TOOL_IDS = new Set([
  "execute",
  "question",
  ...COORDINATION_TOOLS.map((name) => `backseat_${name}`),
]);
export interface CoordinationToolPort {
  diagnostics?: DiagnosticEmitter;
  native: NativeConnection;
  backend: Pick<
    NativeBackend,
    | "inspect"
    | "inspectDeletions"
    | "nativeControl"
    | "recover"
    | "deleteSession"
    | "sendSession"
    | "sessionOperation"
    | "startSupervision"
    | "resumeTask"
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
    id: {
      ...stringSchema,
      description: "New task ID, not a native session ID.",
    },
    title: { ...stringSchema, description: "Short task title." },
    goal: {
      ...stringSchema,
      description: "User-confirmed goal for this worker.",
    },
    criteria: {
      ...stringsSchema,
      description: "Nonempty list of confirmed success criteria.",
    },
    constraints: {
      type: "array",
      items: stringSchema,
      description: "Confirmed constraints; pass [] when there are none.",
    },
    scope: {
      ...stringsSchema,
      description:
        "Nonempty list of approved scope entries; dispatch scope must copy entries from this list.",
    },
    location: {
      ...stringSchema,
      description:
        "Absolute canonical worker project location selected from list_projects, not the coordination data directory.",
    },
    agent: {
      ...stringSchema,
      description:
        "Exact eligible worker agent ID returned by list_agents at this location; adoption must match the session's agent.",
    },
    group: {
      ...stringSchema,
      description:
        "Optional. Required to publish or receive shared snapshots; set the same nonempty group when creating or adopting every participating task.",
    },
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
    createdAt: {
      type: "number",
      description:
        "Session creation time from native time.created, in Unix milliseconds.",
    },
    updatedAt: {
      type: "number",
      description:
        "Last session update from native time.updated, in Unix milliseconds; includes metadata changes, not just conversation activity.",
    },
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
    "createdAt",
    "updatedAt",
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
  (typeof CORE_COORDINATION_TOOLS)[number],
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
  send_session: { type: "object", additionalProperties: true },
  hold_task: { type: "object", additionalProperties: true },
  start_supervision: { type: "object", additionalProperties: true },
  resume_task: { type: "object", additionalProperties: true },
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
  const content = createNativeContent(now);
  const alive = (context: ToolContext) => {
    if (disposed || port.signal.aborted)
      throw new Error("Project adapter is unavailable");
    context.signal.throwIfAborted();
  };
  const owned = async (context: ToolContext) => {
    const snapshot = await port.backend.inspect(context);
    if (snapshot.authority !== "owned")
      throw new Error(
        snapshot.reason ?? "Owned task store required for this query",
      );
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
    diagnostics?: DiagnosticContext,
  ): Promise<T> => {
    try {
      return (await port.native.read(
        (client, signal) =>
          operation(
            client,
            AbortSignal.any([signal, port.signal, context.signal]),
          ),
        diagnostics,
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
  const sessions = async (
    v: Record<string, unknown>,
    context: ToolContext,
    diagnostics: DiagnosticContext,
  ) => {
    exact(v, [
      "statuses",
      "projectID",
      "location",
      "taskIDs",
      "agent",
      "search",
      "parentID",
      "includeSubagents",
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
    if (
      v.includeSubagents !== undefined &&
      typeof v.includeSubagents !== "boolean"
    )
      throw new Error("Invalid subagent selection");
    const includeSubagents = v.includeSubagents === true;
    const parentID =
      v.parentID === null
        ? null
        : (optionalText(v.parentID) ?? (includeSubagents ? undefined : null));
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
      includeSubagents,
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
    const matchesMetadata = (row: Row) =>
      (!projectID || row.projectID === projectID) &&
      (!location || row.location === location) &&
      (!agent || row.agent === agent) &&
      (!workers || workers.includes(row.id)) &&
      (parentID === undefined || row.parentID === parentID) &&
      (includeArchived || !row.archived);
    const buffered = previous?.rows ?? [];
    let rows = buffered,
      next = previous?.nativeCursor,
      degraded = previous?.degraded ?? false;
    let unknownCount = buffered.filter(
      (row) => row.status === "unknown",
    ).length;
    if (!buffered.length && (!previous || next)) {
      const page = await native<NativeInventory>(
        context,
        (client, signal) =>
          readNativeInventory(
            client,
            next,
            signal,
            {
              ...(projectID ? { projectID } : {}),
              ...(location ? { location } : {}),
              ...(search ? { search } : {}),
              ...(parentID !== undefined ? { parentID } : {}),
              includeArchived,
              order,
              limit,
              select: matchesMetadata,
            },
            diagnostics,
          ),
        diagnostics,
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
      rows = await native<Row[]>(
        context,
        (client, signal) =>
          refreshNativeSessions(
            client,
            buffered.filter(matchesMetadata),
            signal,
            diagnostics,
          ),
        diagnostics,
      );
      unknownCount = rows.filter((row) => row.status === "unknown").length;
      degraded = degraded || unknownCount > 0;
    }
    rows = rows.filter(
      (row) =>
        statuses.includes(
          row.status === "waiting-for-input" ? "waiting" : row.status,
        ) && matchesMetadata(row),
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
    diagnostics.emit("debug", "inventory.completed", {
      returnedCount: result.length,
      bufferedCount: remaining.length,
      unknownCount,
      continuation: Boolean(cursor),
    });
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
  type ToolSpec = {
    description: string;
    input: ReturnType<typeof inputSchema>;
    run(
      v: Record<string, unknown>,
      context: ToolContext,
      diagnostics: DiagnosticContext,
    ): Promise<unknown>;
  };
  const nativeSpecs = Object.fromEntries(
    NATIVE_OPERATION_NAMES.map((operation) => {
      const definition = NATIVE_OPERATIONS[operation];
      return [
        operation,
        {
          description: `${definition.description} ${operation === "create_native_session" || operation === "import_session" ? "Select an available canonical project location and eligible agent from the catalogs, and retain the new session identity." : "Select exact sessionID, location and current agent from list_sessions."} No task binding is required. Manual control fences pending automatic decisions.`,
          input: inputSchema(
            {
              sessionID: stringSchema,
              location: stringSchema,
              agent: stringSchema,
              ...definition.input.properties,
            },
            ["sessionID", "location", "agent", ...definition.input.required],
          ),
          async run(v: Record<string, unknown>, context: ToolContext) {
            const { sessionID, location, agent, ...payload } = v;
            return port.backend.sessionOperation(
              {
                operation,
                sessionID: text(sessionID),
                location: text(location),
                agent: text(agent),
                payload,
              },
              context,
            );
          },
        },
      ];
    }),
  );
  const contentSpecs = Object.fromEntries(
    CONTENT_READER_NAMES.map((name) => {
      const definition = CONTENT_READERS[name];
      return [
        name,
        {
          description: definition.description,
          input: definition.input,
          async run(value: Record<string, unknown>, context: ToolContext) {
            const { sendID, ...remaining } = value;
            const query = parseContentQuery(
              definition.kind === "tracking" ? remaining : value,
            );
            await canonical(query.location);
            const incarnation = port.native.identity({
              nonce: "0".repeat(64),
              origin: "backseat-content",
            }).mac;
            return native(context, (client, signal) => {
              const caller = JSON.stringify([context.sessionID, context.agent]);
              if (definition.kind === "tracking")
                return content.follow(
                  { ...query, sendID: text(sendID) },
                  caller,
                  incarnation,
                  client,
                  signal,
                );
              return content.read(
                definition.kind,
                query,
                caller,
                incarnation,
                client,
                signal,
              );
            });
          },
        },
      ];
    }),
  );
  const coreSpecs: Record<
    (typeof CORE_COORDINATION_TOOLS)[number],
    {
      description: string;
      input: ReturnType<typeof inputSchema>;
      run(
        v: Record<string, unknown>,
        context: ToolContext,
        diagnostics: DiagnosticContext,
      ): Promise<unknown>;
    }
  > = {
    list_sessions: {
      description:
        'List native session metadata and hierarchy across projects, including unbound sessions, without TUI attachment. Statuses are OR-ed; different filters are AND-ed. Defaults: running/waiting/inactive, root sessions only, no archived sessions, limit 50, order desc. includeSubagents true includes all hierarchy levels unless parentID explicitly selects roots or direct children. Each call scans at most 200 native rows. Continue with the returned cursor and unchanged filters, limit and order, even after an empty page. partial or unknownCount is not proof of no matches, idle status or completion. Only taskIDs requires owned task storage. Example: {statuses:["running","waiting"],parentID:null,limit:20}.',
      input: inputSchema({
        statuses: {
          type: "array",
          items: { enum: SESSION_STATUSES },
          minItems: 1,
          description:
            "Alternative native statuses. Default excludes unknown. waiting means pending human input, not ordinary inactivity.",
        },
        projectID: {
          ...stringSchema,
          description:
            "Exact native project ID returned by list_projects; omit to search across projects.",
        },
        location: {
          ...stringSchema,
          description:
            "Exact absolute canonical project or sandbox location returned by list_projects; relative paths and aliases are rejected.",
        },
        taskIDs: {
          ...stringsSchema,
          description:
            "Alternative Backseat task IDs, not session IDs; selects their bound workers and requires owned task storage.",
        },
        agent: {
          ...stringSchema,
          description:
            "Exact native worker agent ID; not a display title or substring.",
        },
        search: {
          ...stringSchema,
          description:
            "Search passed to the native service; matching semantics belong to that service, not a local title filter.",
        },
        parentID: {
          anyOf: [stringSchema, { type: "null" }],
          description:
            "Overrides includeSubagents: pass null for roots, or a native session ID for its direct children, not all descendants. Omit to use includeSubagents.",
        },
        includeSubagents: {
          type: "boolean",
          default: false,
          description:
            "Default false selects root sessions only. True includes roots and child sessions. Explicit parentID overrides this flag; keep unchanged while continuing a cursor.",
        },
        includeArchived: {
          type: "boolean",
          description:
            "Default false. To inspect archived sessions, also include unknown in statuses because their live status is unavailable.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description:
            "Maximum returned rows, default 50. Keep unchanged while continuing a cursor; scanning may yield fewer rows.",
        },
        cursor: {
          ...stringSchema,
          description:
            "Opaque cursor from the preceding response. Keep every other argument unchanged. Caller/query/instance-bound; expires after five minutes and may be evicted. Restart without it after expiry, reload or query change.",
        },
        order: {
          enum: ["asc", "desc"],
          description:
            "Native service ordering, default desc; keep unchanged while continuing a cursor.",
        },
      }),
      run: sessions,
    },
    list_projects: {
      description:
        "List native project IDs, titles and canonical or sandbox locations for selecting worker targets. Takes {} and needs neither task-store authority nor TUI attachment. More than 200 choices reports unavailable, not a complete truncated catalog.",
      input: inputSchema({}),
      async run(v, context, diagnostics) {
        exact(v, []);
        return {
          projects: await native(
            context,
            (client, signal) => new NativeDiscovery(client, signal).projects(),
            diagnostics,
          ),
        };
      },
    },
    list_agents: {
      description:
        "List eligible non-coordinator worker agent IDs at the selected canonical location; use these exact IDs for task.agent. No task-store authority or TUI attachment required. More than 200 choices reports unavailable, not a complete truncated catalog.",
      input: inputSchema(
        {
          location: {
            ...stringSchema,
            description:
              "Absolute canonical project or sandbox location returned by list_projects.",
          },
        },
        ["location"],
      ),
      async run(v, context, diagnostics) {
        exact(v, ["location"]);
        const location = await canonical(v.location);
        return {
          location,
          agents: await native(
            context,
            (client, signal) =>
              new NativeDiscovery(client, signal).agents(location),
            diagnostics,
          ),
        };
      },
    },
    list_tasks: {
      description:
        'List protected durable task bindings, not all native sessions. Statuses are OR-ed; different filters are AND-ed. Omitted statuses includes active, held, manual and complete. Returns all matching bindings in one tasks array with no limit or cursor. Requires owned task storage. Example: {statuses:["held","manual"],search:"release"}.',
      input: inputSchema({
        statuses: {
          type: "array",
          items: { enum: TASK_STATUSES },
          minItems: 1,
          description:
            "Alternative task statuses; defaults to all four including complete. These are not native session statuses.",
        },
        location: {
          ...stringSchema,
          description:
            "Exact stored task location, without canonicalisation; copy from a binding or list_projects.",
        },
        group: { ...stringSchema, description: "Exact stored task group." },
        workerID: {
          ...stringSchema,
          description:
            "Exact native session ID bound to a task; not a task ID or agent ID.",
        },
        taskIDs: {
          ...stringsSchema,
          description: "Alternative Backseat task IDs, not native session IDs.",
        },
        search: {
          ...stringSchema,
          description:
            "Case-insensitive substring search across task ID, title and goal.",
        },
      }),
      run: (v, context) => tasks(v, context),
    },
    get_task: {
      description:
        "Read one protected task, delivery identities, completion records, shared context and retained deletion outcomes with current native presence evidence. Observed absence never converts uncertain deletion into success or proves non-delivery.",
      input: inputSchema(
        {
          taskID: {
            ...stringSchema,
            description:
              "Exact Backseat task ID returned by list_tasks, not its worker's native session ID. Requires owned task storage.",
          },
        },
        ["taskID"],
      ),
      run: (v, context) => tasks(v, context, true),
    },
    create_session: {
      description:
        "Create a native worker at task.location using task.agent and deliver the user-confirmed task immediately. Resolve location and agent through list_projects/list_agents first. Requires operation-specific native approval; does not arm automatic follow-ups. Inspect the resulting binding with get_task.",
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
        "Adopt the exact selected native session, including a child, with native approval and no prompt, interruption or agent change. With sessionID alone, returns its identity and an explicit unbound outcome without a task or registration, or takes over an eligible existing binding and fences automation. Completed bindings and changed targets are rejected. Supply task only when the user requests a task binding; task.location and task.agent must match the selected session. Parent and siblings are unchanged.",
      input: inputSchema(
        {
          task: taskSchema,
          sessionID: {
            ...stringSchema,
            description:
              "Exact selected native session ID from list_sessions, including child sessions; not a task ID.",
          },
        },
        ["sessionID"],
      ),
      async run(v, context) {
        exact(v, ["task", "sessionID"]);
        if (!Object.hasOwn(v, "task"))
          return port.backend.nativeControl(
            "adopt",
            "",
            { workerID: text(v.sessionID) },
            context,
          );
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
        "Take manual control of a bound worker, including a child, and fence automatic follow-ups without sending a prompt. Read get_task first; requires operation-specific native approval. Does not take control of its parent or siblings. For an unbound session use adopt_session instead.",
      input: inputSchema(
        {
          taskID: {
            ...stringSchema,
            description:
              "Existing Backseat task ID from list_tasks/get_task, not a native session ID.",
          },
        },
        ["taskID"],
      ),
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
        "Send explicitly requested text to a held/manual task after reading get_task and checking its worker's native status. Stop for waiting human input. scope must be a nonempty declared subset of approved scope; the backend checks entries, not the meaning of text. Native approval binds the exact payload. Never answers pending asks, arms automation or silently retries uncertain delivery. Re-read get_task to inspect delivery records.",
      input: inputSchema(
        {
          taskID: {
            ...stringSchema,
            description:
              "Existing held or manual Backseat task ID, not a native session ID.",
          },
          text: {
            ...stringSchema,
            description:
              "Exact user-requested assignment, within confirmed scope; never a permission or form answer.",
          },
          scope: {
            ...stringsSchema,
            description:
              "Nonempty list of exact entries copied from the current binding's approved scope; no new entries.",
          },
        },
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
    send_session: {
      description:
        "Send user-requested text to a selected native session without creating or adopting a task. options accepts native file, agent and skill attachments, metadata, delivery and resume. Select its exact sessionID, location and agent from list_sessions. Native approval binds the target and complete input. For an already bound task, supply scope copied from its approved scope; the operation takes manual control and fences automation. Returns sessionID, sendID and admitted or uncertain status. Never retry an uncertain send; inspect its existing sendID.",
      input: inputSchema(
        {
          sessionID: stringSchema,
          location: stringSchema,
          agent: stringSchema,
          text: { ...stringSchema, maxLength: 12_000 },
          scope: stringsSchema,
          options: NATIVE_SEND_OPTIONS.prompt,
        },
        ["sessionID", "location", "agent", "text"],
      ),
      async run(v, context) {
        exact(v, [
          "sessionID",
          "location",
          "agent",
          "text",
          "scope",
          "options",
        ]);
        return port.backend.sendSession(
          {
            sessionID: text(v.sessionID),
            location: text(v.location),
            agent: text(v.agent),
            text: text(v.text),
            ...(v.options === undefined ? {} : { options: object(v.options) }),
            ...(v.scope === undefined ? {} : { scope: list(v.scope, text) }),
          },
          context,
        );
      },
    },
    start_supervision: {
      description:
        "Start a server-owned supervision generation for this coordinator under operation-bound native approval. Fences previous automatic decisions and preserves consumed limits and delivery identities. Returns generation, coordinatorID and held status; starting inventories authority but never implicitly resumes tasks. No terminal attachment or proof is required.",
      input: inputSchema({}, []),
      async run(v, context) {
        exact(v, []);
        return port.backend.startSupervision(context);
      },
    },
    resume_task: {
      description:
        "Resume one selected task under operation-bound native approval in the current server supervision generation. Requires start_supervision, fresh globally settled native worker state, no pending human requests, reconciled delivery identities and remaining finite limits. Preserves counters and rechecks native evidence after approval; no terminal attachment is required.",
      input: inputSchema({ taskID: stringSchema }, ["taskID"]),
      async run(v, context) {
        exact(v, ["taskID"]);
        return port.backend.resumeTask(text(v.taskID), context);
      },
    },
    hold_task: {
      description:
        "Hold a task and invalidate automatic decisions while preserving all counters and delivery records. Read get_task first; requires operation-specific native approval. Holding does not undo already delivered work.",
      input: inputSchema(
        {
          taskID: {
            ...stringSchema,
            description:
              "Existing Backseat task ID from list_tasks/get_task, not a native session ID.",
          },
        },
        ["taskID"],
      ),
      async run(v, context) {
        exact(v, ["taskID"]);
        return port.backend.nativeControl("hold", text(v.taskID), {}, context);
      },
    },
    share_context: {
      description:
        "Publish an optional user-approved snapshot and replace one task's selected shared versions with the required shared list. Read get_task first; references must match the task's group and authorised task-ID recipients. Publishing alone is not selection. Native approval is required. shared:[] revokes future inputs only, not past worker history. Inspect the resulting task with get_task.",
      input: inputSchema(
        {
          taskID: {
            ...stringSchema,
            description:
              "Recipient Backseat task ID whose shared-version selection is replaced, not a native session ID.",
          },
          snapshot: inputSchema(
            {
              id: {
                ...stringSchema,
                description:
                  "Shared snapshot ID, used with version in shared references.",
              },
              version: {
                type: "integer",
                minimum: 1,
                description:
                  "Explicit positive snapshot version; no implicit latest selection.",
              },
              group: {
                ...stringSchema,
                description:
                  "Authorisation group matching recipient task bindings.",
              },
              content: {
                ...stringSchema,
                description:
                  "User-approved shared evidence; never instructions granting consent or wider scope.",
              },
              recipients: {
                ...stringsSchema,
                description:
                  "Nonempty list of authorised Backseat task IDs, not native session IDs; group membership alone does not share context.",
              },
            },
            ["id", "version", "group", "content", "recipients"],
          ),
          shared: {
            type: "array",
            description:
              "Complete replacement selection of exact snapshot ID/version pairs for taskID; [] clears future shared inputs. Include a published snapshot here to select it.",
            items: inputSchema(
              {
                id: { ...stringSchema, description: "Published snapshot ID." },
                version: {
                  type: "integer",
                  minimum: 1,
                  description:
                    "Exact published positive version to select, not an implicit latest version.",
                },
              },
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
        "Recover a terminated runtime owner through native approval after its termination is established. Takes {}. Does not arm optional automation or retry uncertain deliveries; re-inspect task state after recovery.",
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
      input: inputSchema(
        {
          sessionID: {
            ...stringSchema,
            description:
              "Exact native session ID selected from list_sessions for operation-specific approval of recursive subtree removal; not a Backseat task ID.",
          },
        },
        ["sessionID"],
      ),
      async run(v, context) {
        exact(v, ["sessionID"]);
        return port.backend.deleteSession(text(v.sessionID), context);
      },
    },
  };
  const specs: Record<string, ToolSpec> = {
    ...coreSpecs,
    ...nativeSpecs,
    ...Object.fromEntries(
      Object.entries(NATIVE_SEND_DESCRIPTIONS).map(([kind, description]) => [
        `${kind}_session`,
        {
          description: `${description} Select exact sessionID, location and current agent from list_sessions. No task binding is required. Bound sessions require their approved scope and take manual control. Returns sendID and admitted or uncertain; inspect an uncertain identity, never resend it.`,
          input: inputSchema(
            {
              sessionID: stringSchema,
              location: stringSchema,
              agent: stringSchema,
              text: stringSchema,
              scope: stringsSchema,
              options: NATIVE_SEND_OPTIONS[kind as NativeSendKind],
            },
            [
              "sessionID",
              "location",
              "agent",
              ...(kind === "compact" || kind === "skill" ? [] : ["text"]),
              ...(kind === "command" || kind === "skill" ? ["options"] : []),
            ],
          ),
          async run(v: Record<string, unknown>, context: ToolContext) {
            exact(v, [
              "sessionID",
              "location",
              "agent",
              "text",
              "scope",
              "options",
            ]);
            return port.backend.sendSession(
              {
                sessionID: text(v.sessionID),
                location: text(v.location),
                agent: text(v.agent),
                text:
                  v.text === undefined &&
                  (kind === "compact" || kind === "skill")
                    ? kind
                    : text(v.text),
                kind: kind as NativeSendKind,
                ...(v.scope === undefined
                  ? {}
                  : { scope: list(v.scope, text) }),
                ...(v.options === undefined
                  ? {}
                  : { options: object(v.options) }),
              },
              context,
            );
          },
        },
      ]),
    ),
    ...contentSpecs,
  };
  const toolSpec = (name: string): ToolSpec => {
    const spec = specs[name];
    if (!spec) throw new Error("Missing native tool definition");
    return spec;
  };
  return {
    tools: COORDINATION_TOOLS.map((name): Info => ({
      name,
      description: toolSpec(name).description,
      input: toolSpec(name).input,
      output:
        name in outputSchemas
          ? outputSchemas[name as keyof typeof outputSchemas]
          : { type: "object", additionalProperties: true },
      options: { namespace: "backseat", codemode: true },
      async execute(input: unknown, context) {
        const diagnostics = diagnosticContext(port.diagnostics, "tool", name);
        diagnostics.emit("debug", "tool.started");
        try {
          alive(context);
          await port.authorize(context);
          alive(context);
          const output = await toolSpec(name).run(
            object(input),
            {
              ...context,
              signal: AbortSignal.any([port.signal, context.signal]),
            },
            diagnostics,
          );
          alive(context);
          diagnostics.emit("debug", "tool.completed");
          return { output };
        } catch (error) {
          diagnostics.emit("error", "tool.failed", {
            classification: port.signal.aborted
              ? "disposed"
              : context.signal.aborted
                ? "cancelled"
                : "unknown",
          });
          throw error;
        }
      },
    })),
    dispose() {
      disposed = true;
      pages.clear();
      content.dispose();
    },
  };
}
