import type { Info, ToolContext } from "@opencode/plugin/promise/tool";
import {
  diagnosticContext,
  type NativeConnection,
  type DiagnosticEmitter,
  type DiagnosticContext,
} from "./native-connection.ts";
import type { SessionController } from "./server.ts";
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
  "list_followed_sessions",
  "create_session",
  "adopt_session",
  "stop_following",
  "send_session",
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
    SessionController,
    | "listFollowedSessions"
    | "createSession"
    | "adoptSession"
    | "stopFollowing"
    | "deleteSession"
    | "sendSession"
    | "sessionOperation"
  >;
  canonical(location: string): Promise<string>;
  authorize(context: ToolContext): Promise<void>;
  signal: AbortSignal;
  now?: () => number;
}
const PAGE_TTL = 5 * 60_000,
  PAGE_CAPACITY = 128;
const SESSION_STATUSES = ["running", "waiting", "inactive", "unknown"] as const;
const stringSchema = { type: "string", minLength: 1 } as const;
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
  required: readonly string[] = [],
) {
  return { type: "object", properties, required, additionalProperties: false };
}

export function createCoordinationTools(port: CoordinationToolPort): {
  tools: Info[];
  dispose(): void;
} {
  const pages = new Map<string, Continuation>(),
    incarnation = process.hrtime.bigint().toString(10);
  let sequence = 0,
    disposed = false;
  const now = port.now ?? Date.now,
    content = createNativeContent(now);
  const alive = (context: ToolContext) => {
    if (disposed || port.signal.aborted)
      throw new Error("Project adapter is unavailable");
    context.signal.throwIfAborted();
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
    const includeArchived = v.includeArchived === true,
      limit = v.limit === undefined ? 50 : integer(v.limit, 1);
    if (limit > 200) throw new Error("Session limit exceeds 200");
    const order = v.order ?? "desc";
    if (order !== "asc" && order !== "desc")
      throw new Error("Invalid session order");
    const query = fingerprint({
        statuses,
        projectID,
        location,
        agent,
        search,
        parentID,
        includeSubagents,
        includeArchived,
        limit,
        order,
      }),
      caller = JSON.stringify([context.sessionID, context.agent]);
    const id = v.cursor === undefined ? undefined : text(v.cursor),
      previous = id ? pages.get(id) : undefined;
    if (
      id &&
      (!previous ||
        previous.caller !== caller ||
        previous.query !== query ||
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
            query,
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
  type ToolSpec = {
    description: string;
    input: ReturnType<typeof inputSchema>;
    run(
      v: Record<string, unknown>,
      context: ToolContext & { revalidate: () => Promise<void> },
      diagnostics: DiagnosticContext,
    ): Promise<unknown>;
  };
  const specs: Record<string, ToolSpec> = {
    list_sessions: {
      description:
        "List native session metadata and hierarchy across projects without TUI attachment. Statuses are OR-ed; different filters are AND-ed. Defaults: running/waiting/inactive, root sessions only, no archived sessions, limit 50, order desc. includeSubagents includes all levels unless parentID selects roots or direct children. Each call scans at most 200 rows. Continue with the opaque cursor and unchanged filters even after an empty page. partial or unknownCount is not proof of no matches or completion.",
      input: inputSchema({
        statuses: {
          type: "array",
          items: { enum: SESSION_STATUSES },
          minItems: 1,
        },
        projectID: stringSchema,
        location: stringSchema,
        agent: stringSchema,
        search: stringSchema,
        parentID: { anyOf: [stringSchema, { type: "null" }] },
        includeSubagents: { type: "boolean", default: false },
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        cursor: {
          ...stringSchema,
          description:
            "Opaque caller/query/instance-bound cursor; expires after five minutes. Keep every other argument unchanged.",
        },
        order: { enum: ["asc", "desc"] },
      }),
      run: sessions,
    },
    list_projects: {
      description:
        "List native project IDs, titles and canonical or sandbox locations. Takes {}. Catalogs larger than 200 report unavailable rather than a truncated complete result.",
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
        "List eligible worker agent IDs at an absolute canonical location from list_projects. Use the exact returned ID when creating a worker.",
      input: inputSchema({ location: stringSchema }, ["location"]),
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
    list_followed_sessions: {
      description:
        "List sessions followed by this coordinator and retained delivery outcomes. Takes {}. Does not expose another coordinator's following or delivery records.",
      input: inputSchema({}),
      async run(v, context) {
        exact(v, []);
        return port.backend.listFollowedSessions(context);
      },
    },
    create_session: {
      description:
        "Create a native worker at the selected catalog location and agent, then follow it automatically. Sends no initial message. Returns session identity and following state. Configured native permissions apply.",
      input: inputSchema(
        { location: stringSchema, agent: stringSchema, title: stringSchema },
        ["location", "agent"],
      ),
      async run(v, context) {
        exact(v, ["location", "agent", "title"]);
        return port.backend.createSession(
          {
            location: await canonical(v.location),
            agent: text(v.agent),
            ...(v.title === undefined ? {} : { title: text(v.title) }),
          },
          context,
        );
      },
    },
    adopt_session: {
      description:
        "Take over and automatically follow the exact existing session, including a child, without sending, interrupting, changing its agent or following its parent/siblings. No task or send anchor is needed. Configured native permissions apply.",
      input: inputSchema({ sessionID: stringSchema }, ["sessionID"]),
      async run(v, context) {
        exact(v, ["sessionID"]);
        return port.backend.adoptSession(text(v.sessionID), context);
      },
    },
    stop_following: {
      description:
        "Stop this coordinator's following and discard unsent summaries for the selected session. Does not send, interrupt or delete the worker. Already admitted notifications remain in coordinator history.",
      input: inputSchema({ sessionID: stringSchema }, ["sessionID"]),
      async run(v, context) {
        exact(v, ["sessionID"]);
        return port.backend.stopFollowing(text(v.sessionID), context);
      },
    },
    send_session: {
      description:
        "Send text to the exact native session/location/current agent. options accepts native attachments, metadata, delivery and resume. Configured native permissions apply. Returns sessionID, sendID and admitted or uncertain status; inspect uncertain identities rather than resend.",
      input: inputSchema(
        {
          sessionID: stringSchema,
          location: stringSchema,
          agent: stringSchema,
          text: { ...stringSchema, maxLength: 12_000 },
          options: NATIVE_SEND_OPTIONS.prompt,
        },
        ["sessionID", "location", "agent", "text"],
      ),
      async run(v, context) {
        exact(v, ["sessionID", "location", "agent", "text", "options"]);
        return port.backend.sendSession(
          {
            sessionID: text(v.sessionID),
            location: text(v.location),
            agent: text(v.agent),
            text: text(v.text),
            ...(v.options === undefined ? {} : { options: object(v.options) }),
          },
          context,
        );
      },
    },
    delete_session: {
      description:
        "Delete the selected native session and its recursive subtree, stopping active execution. Concurrent descendants are included. Rejects this coordinator and its ancestors. Retains uncertain outcomes and never retries an uncertain deletion. Configured native permissions apply.",
      input: inputSchema({ sessionID: stringSchema }, ["sessionID"]),
      async run(v, context) {
        exact(v, ["sessionID"]);
        return port.backend.deleteSession(text(v.sessionID), context);
      },
    },
  };
  for (const operation of NATIVE_OPERATION_NAMES) {
    const definition = NATIVE_OPERATIONS[operation];
    specs[operation] = {
      description: `${definition.description} Select exact sessionID, canonical location and current agent. Configured native permissions apply. Created or imported sessions are followed automatically.`,
      input: inputSchema(
        {
          sessionID: stringSchema,
          location: stringSchema,
          agent: stringSchema,
          ...definition.input.properties,
        },
        ["sessionID", "location", "agent", ...definition.input.required],
      ),
      async run(v, context) {
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
    };
  }
  for (const [kind, description] of Object.entries(NATIVE_SEND_DESCRIPTIONS)) {
    specs[`${kind}_session`] = {
      description: `${description} Select exact sessionID, location and current agent. Configured native permissions apply. Returns sendID and admitted or uncertain; inspect an uncertain identity, never resend it.`,
      input: inputSchema(
        {
          sessionID: stringSchema,
          location: stringSchema,
          agent: stringSchema,
          text: stringSchema,
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
      async run(v, context) {
        exact(v, ["sessionID", "location", "agent", "text", "options"]);
        return port.backend.sendSession(
          {
            sessionID: text(v.sessionID),
            location: text(v.location),
            agent: text(v.agent),
            text:
              v.text === undefined && (kind === "compact" || kind === "skill")
                ? kind
                : text(v.text),
            kind: kind as NativeSendKind,
            ...(v.options === undefined ? {} : { options: object(v.options) }),
          },
          context,
        );
      },
    };
  }
  for (const name of CONTENT_READER_NAMES) {
    const definition = CONTENT_READERS[name];
    specs[name] = {
      description: definition.description,
      input: definition.input,
      async run(value, context) {
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
          return definition.kind === "tracking"
            ? content.follow(
                { ...query, sendID: text(sendID) },
                caller,
                incarnation,
                client,
                signal,
              )
            : content.read(
                definition.kind,
                query,
                caller,
                incarnation,
                client,
                signal,
              );
        });
      },
    };
  }
  return {
    tools: COORDINATION_TOOLS.map((name): Info => ({
      name,
      description: specs[name]!.description,
      input: specs[name]!.input,
      output: { type: "object", additionalProperties: true },
      options: { namespace: "backseat", codemode: true },
      async execute(input: unknown, context) {
        const diagnostics = diagnosticContext(port.diagnostics, "tool", name);
        diagnostics.emit("debug", "tool.started");
        try {
          alive(context);
          await port.authorize(context);
          alive(context);
          const output = await specs[name]!.run(
            object(input),
            {
              ...context,
              signal: AbortSignal.any([port.signal, context.signal]),
              revalidate: () => port.authorize(context),
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
