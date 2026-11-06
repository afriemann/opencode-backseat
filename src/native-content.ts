import type { OpenCodeClient, MessageListInput } from "@opencode/client";
import { randomUUID } from "node:crypto";
import { exact, fingerprint, integer, text } from "./state.ts";

export const CONTENT_BOUNDS = {
  pageItems: 100,
  pageBytes: 64_000,
  nativeBytes: 8_000_000,
  handles: 128,
  ttlMs: 5 * 60_000,
} as const;
export const MESSAGE_TYPES = [
  "agent-switched",
  "model-switched",
  "location-switched",
  "user",
  "synthetic",
  "system",
  "skill",
  "shell",
  "assistant",
  "compaction",
  "idle",
] as const;
const stringSchema = { type: "string", minLength: 1 } as const;
const commonProperties = {
  sessionID: stringSchema,
  location: stringSchema,
  agent: stringSchema,
  cursor: stringSchema,
  limit: { type: "integer", minimum: 1, maximum: CONTENT_BOUNDS.pageItems },
  maxBytes: {
    type: "integer",
    minimum: 1024,
    maximum: CONTENT_BOUNDS.pageBytes,
  },
};
function reader(
  kind: ContentKind,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
) {
  return {
    kind,
    description: `${description} Select exact sessionID and canonical location from list_sessions; agent optionally confirms the current agent. No task binding or terminal attachment is required. Returns bounded data or json-text chunks with offsetChars and an opaque cursor. Continue with the same arguments and cursor; concatenate chunks for one native page. Handles expire after five minutes and bind the caller, service, target and query. Changed chunk content requires restarting the read. Defaults: 20 messages, 24000 response bytes.`,
    input: {
      type: "object",
      properties: { ...commonProperties, ...properties },
      required: ["sessionID", "location", ...required],
      additionalProperties: false,
    },
  };
}
export const CONTENT_READERS = {
  read_session_messages: reader(
    "messages",
    "Read a native message-history page, preserving native chronological order and type filtering. This is not a poll for updates to an already-read unfinished message.",
    { order: { enum: ["asc", "desc"] }, type: { enum: MESSAGE_TYPES } },
  ),
  read_session_message: reader(
    "message",
    "Read one current native message, including unfinished streaming content.",
    { messageID: stringSchema },
    ["messageID"],
  ),
  read_session_context: reader(
    "context",
    "Read the selected session's current native context window.",
  ),
  read_session_diff: reader(
    "diff",
    "Read native file diffs for the selected session, optionally between native boundaries.",
    {
      from: stringSchema,
      to: stringSchema,
      context: { type: "integer", minimum: 0 },
    },
  ),
  read_session_inbox: reader(
    "inbox",
    "Inspect the selected session's native queued input and delivery IDs.",
  ),
  list_session_permissions: reader(
    "permissions",
    "Inspect pending permission requests for the selected native session.",
  ),
  get_session_permission: reader(
    "permission",
    "Inspect one pending native permission request before an explicitly approved reply.",
    { requestID: stringSchema },
    ["requestID"],
  ),
  list_saved_permissions: reader(
    "saved_permissions",
    "Inspect saved permission rules for the selected session's native project, not all projects.",
  ),
  list_session_forms: reader(
    "forms",
    "Inspect pending native forms for the selected session.",
  ),
  get_session_form: reader(
    "form",
    "Inspect one native form's typed fields and current answer state.",
    { formID: stringSchema },
    ["formID"],
  ),
  list_session_instructions: reader(
    "instructions",
    "Read native persistent instruction entries for the selected session.",
  ),
  read_session_stats: reader(
    "stats",
    "Read native usage statistics for the selected session's project. The native API aggregates project usage, not only this session.",
    {
      statsFrom: { type: "integer", minimum: 0 },
      statsTo: { type: "integer", minimum: 0 },
      timezone: stringSchema,
      toolsLevel: { enum: ["none", "summary", "detail"] },
    },
  ),
  export_session: reader(
    "export",
    "Export native session transfer data in bounded chunks. sanitize defaults to true; set false explicitly only when unsanitized native transfer content is required.",
    { sanitize: { type: "boolean" } },
  ),
  follow_session: {
    kind: "tracking",
    description:
      "Follow bounded native activity after a retained sendID, such as the ID returned by send_session or a selected native inbox/message ID. Supply exact sessionID and canonical location; agent optionally confirms the target. Returns send-anchor status, exclusive afterSeq, bounded event summaries and changed assistant-message updates, including in-progress text. Output is since-send activity, not proof of causal attribution; interleaved flags other delivered inputs. Continue polling with cursor and unchanged arguments; more means immediate catch-up remains. Unfinished messages are refetched without replaying full history. Large updates use json-text chunks keyed by messageID, version and offsetChars; replace starts a new version. Handles expire after five inactive minutes. Discontinuity or unavailable history is explicit, never an empty-success claim. Retain the send ID and do not resend to recover tracking. Defaults: 50 events and 24000 bytes per call; max 100 events and 64000 bytes.",
    input: {
      type: "object",
      properties: { ...commonProperties, sendID: stringSchema },
      required: ["sessionID", "location", "sendID"],
      additionalProperties: false,
    },
  },
} as const;
export const CONTENT_READER_NAMES = Object.keys(
  CONTENT_READERS,
) as (keyof typeof CONTENT_READERS)[];

export type ContentKind =
  | "messages"
  | "message"
  | "context"
  | "diff"
  | "inbox"
  | "permissions"
  | "permission"
  | "saved_permissions"
  | "forms"
  | "form"
  | "instructions"
  | "stats"
  | "export";
export interface ContentQuery {
  sessionID: string;
  location: string;
  agent?: string;
  cursor?: string | undefined;
  limit?: number;
  maxBytes?: number;
  order?: "asc" | "desc";
  type?: string;
  messageID?: string;
  requestID?: string;
  formID?: string;
  from?: string;
  to?: string;
  context?: number;
  sanitize?: boolean;
  statsFrom?: number;
  statsTo?: number;
  timezone?: string;
  toolsLevel?: "none" | "summary" | "detail";
}
export interface ContentPage {
  available: boolean;
  data?: unknown;
  chunk?: string;
  encoding?: "json-text";
  offsetChars?: number;
  cursor?: string;
}
export interface TrackingQuery extends Pick<
  ContentQuery,
  "sessionID" | "location" | "agent" | "cursor" | "limit" | "maxBytes"
> {
  sendID: string;
}
export interface MessageUpdate {
  messageID: string;
  version: string;
  replace: boolean;
  message?: unknown;
  encoding?: "json-text";
  chunk?: string;
  offsetChars?: number;
}
export interface TrackingPage {
  available: boolean;
  kind: "since-send-activity";
  attribution: "uncertain";
  status: "tracking" | "discontinuity";
  sendID: string;
  anchor: "pending" | "delivered";
  afterSeq: number;
  interleaved: boolean;
  events: { type: string; seq: number; assistantMessageID?: string }[];
  updates: MessageUpdate[];
  more: boolean;
  cursor?: string;
  reason?: string;
}
export function parseContentQuery(
  value: Record<string, unknown>,
): ContentQuery {
  exact(value, [
    "sessionID",
    "location",
    "agent",
    "cursor",
    "limit",
    "maxBytes",
    "order",
    "type",
    "messageID",
    "requestID",
    "formID",
    "from",
    "to",
    "context",
    "sanitize",
    "statsFrom",
    "statsTo",
    "timezone",
    "toolsLevel",
  ]);
  const result: ContentQuery = {
    sessionID: text(value.sessionID),
    location: text(value.location),
  };
  for (const key of [
    "agent",
    "cursor",
    "type",
    "messageID",
    "requestID",
    "formID",
    "from",
    "to",
    "timezone",
  ] as const)
    if (value[key] !== undefined) result[key] = text(value[key]);
  for (const key of [
    "limit",
    "maxBytes",
    "context",
    "statsFrom",
    "statsTo",
  ] as const)
    if (value[key] !== undefined) result[key] = integer(value[key], 0);
  if (value.order !== undefined) {
    if (value.order !== "asc" && value.order !== "desc")
      throw new Error("Invalid native message order");
    result.order = value.order;
  }
  if (value.sanitize !== undefined) {
    if (typeof value.sanitize !== "boolean")
      throw new Error("Invalid native export option");
    result.sanitize = value.sanitize;
  }
  if (value.toolsLevel !== undefined) {
    if (
      value.toolsLevel !== "none" &&
      value.toolsLevel !== "summary" &&
      value.toolsLevel !== "detail"
    )
      throw new Error("Invalid native statistics detail level");
    result.toolsLevel = value.toolsLevel;
  }
  return result;
}
interface Continuation {
  caller: string;
  incarnation: string;
  query: string;
  target: string;
  expires: number;
  nativeCursor?: string;
  offset: number;
  pageFingerprint?: string;
}
interface TrackingState {
  caller: string;
  incarnation: string;
  query: string;
  target: string;
  expires: number;
  afterSeq: number;
  anchor: "pending" | "delivered";
  interleaved: boolean;
  messages: {
    id: string;
    version?: string;
    offset: number;
    delivered: boolean;
    ended: boolean;
  }[];
}
function prefix(value: string, byteLimit: number): string {
  let bytes = 0,
    result = "";
  for (const point of value) {
    bytes += Buffer.byteLength(point);
    if (bytes > byteLimit) break;
    result += point;
  }
  return result;
}
function nativeID(value: unknown): string {
  const id = text(value);
  if (id.length > 200) throw new Error("Native identity exceeds its bound");
  return id;
}
export function createNativeContent(now: () => number = Date.now) {
  const handles = new Map<string, Continuation>();
  const trackers = new Map<string, TrackingState>();
  let disposed = false;
  const remember = (handle: Continuation): string => {
    for (const [key, value] of handles)
      if (value.expires <= now()) handles.delete(key);
    while (handles.size >= CONTENT_BOUNDS.handles)
      handles.delete(handles.keys().next().value!);
    const key = randomUUID();
    handles.set(key, handle);
    return key;
  };
  return {
    async read(
      kind: ContentKind,
      input: ContentQuery,
      caller: string,
      incarnation: string,
      client: OpenCodeClient,
      signal: AbortSignal,
    ): Promise<ContentPage> {
      signal.throwIfAborted();
      if (disposed) throw new Error("Native content reader is disposed");
      exact({ ...input }, [
        "sessionID",
        "location",
        "agent",
        "cursor",
        "limit",
        "maxBytes",
        "order",
        "type",
        "messageID",
        "requestID",
        "formID",
        "from",
        "to",
        "context",
        "sanitize",
        "statsFrom",
        "statsTo",
        "timezone",
        "toolsLevel",
      ]);
      const sessionID = text(input.sessionID),
        location = text(input.location),
        agent = input.agent === undefined ? undefined : text(input.agent);
      const limit = input.limit === undefined ? 20 : integer(input.limit, 1);
      const maxBytes =
        input.maxBytes === undefined ? 24_000 : integer(input.maxBytes, 1024);
      const order = input.order ?? "asc";
      if (
        limit > CONTENT_BOUNDS.pageItems ||
        maxBytes > CONTENT_BOUNDS.pageBytes
      )
        throw new Error("Native content page exceeds its bound");
      if (order !== "asc" && order !== "desc")
        throw new Error("Invalid native message order");
      if (
        input.type !== undefined &&
        !(MESSAGE_TYPES as readonly string[]).includes(input.type)
      )
        throw new Error("Invalid native message type");
      if (input.sanitize !== undefined && typeof input.sanitize !== "boolean")
        throw new Error("Invalid native export option");
      if (input.context !== undefined) integer(input.context, 0);
      const query = fingerprint([
        kind,
        { ...input, cursor: undefined, limit, maxBytes, order },
      ]);
      const cursor =
        input.cursor === undefined ? undefined : text(input.cursor);
      const previous = cursor ? handles.get(cursor) : undefined;
      if (input.cursor) {
        if (!previous || previous.expires <= now())
          throw new Error(
            "Content continuation unavailable or expired; restart this read",
          );
        if (previous.query !== query)
          throw new Error(
            "Content continuation query changed; restart this read",
          );
        if (previous.caller !== caller || previous.incarnation !== incarnation)
          throw new Error(
            "Content continuation caller or service changed; restart this read",
          );
      }
      const session = await client.session.get({ sessionID }, { signal });
      const target = fingerprint([
        session.id,
        session.projectID,
        session.agent,
        session.location,
        session.parentID,
        session.revert,
      ]);
      if (
        session.id !== sessionID ||
        session.location.directory !== location ||
        (agent !== undefined && session.agent !== agent) ||
        (previous && previous.target !== target)
      )
        throw new Error("Selected content target or history changed");
      let data: unknown, next: string | undefined;
      const options = { signal };
      switch (kind) {
        case "messages": {
          const nativeQuery: MessageListInput = {
            sessionID,
            limit,
            ...(previous?.nativeCursor
              ? { cursor: previous.nativeCursor }
              : { order }),
            ...(input.type === undefined
              ? {}
              : { type: input.type as MessageListInput["type"] }),
          };
          const page = await client.message.list(nativeQuery, options);
          if (
            page.data.length > limit ||
            (previous?.nativeCursor &&
              page.cursor.next === previous.nativeCursor)
          )
            throw new Error(
              "Native message continuation did not advance within bounds",
            );
          data = page.data;
          next = page.cursor.next ?? undefined;
          break;
        }
        case "message":
          data = await client.session.message.get(
            { sessionID, messageID: text(input.messageID) },
            options,
          );
          break;
        case "context":
          data = await client.session.context({ sessionID }, options);
          break;
        case "diff":
          data = await client.session.diff(
            {
              sessionID,
              ...(input.from === undefined ? {} : { from: text(input.from) }),
              ...(input.to === undefined ? {} : { to: text(input.to) }),
              ...(input.context === undefined
                ? {}
                : { context: input.context }),
            },
            options,
          );
          break;
        case "inbox":
          data = await client.session.inbox.list({ sessionID }, options);
          break;
        case "permissions":
          data = await client.permission.list({ sessionID }, options);
          break;
        case "permission": {
          const requestID = text(input.requestID);
          const request = await client.permission.get(
            { sessionID, requestID },
            options,
          );
          if (request.sessionID !== sessionID || request.id !== requestID)
            throw new Error("Native permission target changed");
          data = request;
          break;
        }
        case "saved_permissions":
          data = await client.permission.saved.list(
            { projectID: session.projectID },
            options,
          );
          break;
        case "forms":
          data = await client.session.form.list({ sessionID }, options);
          break;
        case "form": {
          const formID = text(input.formID);
          const form = await client.session.form.get(
            { sessionID, formID },
            options,
          );
          if (form.sessionID !== sessionID || form.id !== formID)
            throw new Error("Native form target changed");
          data = form;
          break;
        }
        case "instructions":
          data = await client.experimental.session.instructions.entry.list(
            { sessionID },
            options,
          );
          break;
        case "stats":
          data = await client.experimental.session.stats(
            {
              project: session.projectID,
              ...(input.statsFrom === undefined
                ? {}
                : { from: integer(input.statsFrom, 0) }),
              ...(input.statsTo === undefined
                ? {}
                : { to: integer(input.statsTo, 0) }),
              ...(input.timezone === undefined
                ? {}
                : { timezone: text(input.timezone) }),
              tools: input.toolsLevel ?? "none",
            },
            options,
          );
          break;
        case "export":
          data = await client.experimental.session.export(
            { sessionID, sanitize: input.sanitize ?? true },
            options,
          );
          break;
        default:
          throw new Error("Unsupported native content read");
      }
      signal.throwIfAborted();
      if (disposed) throw new Error("Native content reader is disposed");
      const after = await client.session.get({ sessionID }, options);
      if (
        fingerprint([
          after.id,
          after.projectID,
          after.agent,
          after.location,
          after.parentID,
          after.revert,
        ]) !== target
      )
        throw new Error(
          "Selected content target or history changed during read",
        );
      const serialized = JSON.stringify(data);
      if (
        serialized === undefined ||
        Buffer.byteLength(serialized) > CONTENT_BOUNDS.nativeBytes
      )
        throw new Error(
          "Native content unavailable within response bounds; narrow the read",
        );
      const pageFingerprint = fingerprint(data),
        offset = previous?.offset ?? 0;
      if (offset > 0 && previous?.pageFingerprint !== pageFingerprint)
        throw new Error(
          "Native content changed during chunk continuation; restart this read",
        );
      const base = {
        caller,
        incarnation,
        query,
        target,
        expires: previous?.expires ?? now() + CONTENT_BOUNDS.ttlMs,
      };
      let result: ContentPage;
      if (offset === 0 && Buffer.byteLength(serialized) + 128 <= maxBytes) {
        result = {
          available: true,
          data,
          ...(next
            ? { cursor: remember({ ...base, nativeCursor: next, offset: 0 }) }
            : {}),
        };
      } else {
        const chunk = prefix(
          serialized.slice(offset),
          Math.floor((maxBytes - 512) / 2),
        );
        const following = offset + chunk.length;
        result = {
          available: true,
          encoding: "json-text",
          chunk,
          offsetChars: offset,
          ...(following < serialized.length
            ? {
                cursor: remember({
                  ...base,
                  ...(previous?.nativeCursor
                    ? { nativeCursor: previous.nativeCursor }
                    : {}),
                  offset: following,
                  pageFingerprint,
                }),
              }
            : next
              ? { cursor: remember({ ...base, nativeCursor: next, offset: 0 }) }
              : {}),
        };
      }
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
        throw new Error("Native content result exceeds its byte bound");
      return result;
    },
    async follow(
      input: TrackingQuery,
      caller: string,
      incarnation: string,
      client: OpenCodeClient,
      signal: AbortSignal,
    ): Promise<TrackingPage> {
      const output: TrackingPage = {
        available: false,
        kind: "since-send-activity",
        attribution: "uncertain",
        status: "discontinuity",
        sendID:
          typeof input.sendID === "string" && input.sendID.length <= 200
            ? input.sendID
            : "",
        anchor: "pending",
        afterSeq: 0,
        interleaved: false,
        events: [],
        updates: [],
        more: false,
      };
      const discontinuity = (reason: string): TrackingPage => ({
        ...output,
        available: false,
        status: "discontinuity",
        events: [],
        updates: [],
        more: false,
        reason,
      });
      try {
        signal.throwIfAborted();
        if (disposed)
          return discontinuity("Activity reader is disposed; restart tracking");
        exact({ ...input }, [
          "sessionID",
          "location",
          "agent",
          "sendID",
          "cursor",
          "limit",
          "maxBytes",
        ]);
        const sessionID = nativeID(input.sessionID),
          sendID = nativeID(input.sendID),
          location = text(input.location);
        const limit = input.limit === undefined ? 50 : integer(input.limit, 1);
        const maxBytes =
          input.maxBytes === undefined ? 24_000 : integer(input.maxBytes, 1024);
        if (
          limit > CONTENT_BOUNDS.pageItems ||
          maxBytes > CONTENT_BOUNDS.pageBytes
        )
          return discontinuity("Activity read exceeds its response bounds");
        const query = fingerprint([
          sessionID,
          location,
          input.agent,
          sendID,
          limit,
          maxBytes,
        ]);
        const previous =
          input.cursor === undefined
            ? undefined
            : trackers.get(text(input.cursor));
        if (
          input.cursor !== undefined &&
          (!previous ||
            previous.query !== query ||
            previous.caller !== caller ||
            previous.incarnation !== incarnation ||
            previous.expires <= now())
        )
          return discontinuity(
            "Activity continuation unavailable, expired, or its caller, service or query changed",
          );
        const session = await client.session.get({ sessionID }, { signal });
        const target = fingerprint([
          session.id,
          session.projectID,
          session.agent,
          session.location,
          session.parentID,
          session.revert,
        ]);
        if (
          session.id !== sessionID ||
          session.location.directory !== location ||
          (input.agent !== undefined && session.agent !== input.agent) ||
          (previous && previous.target !== target)
        )
          return discontinuity("Selected activity target or history changed");
        const state: TrackingState = previous
          ? structuredClone(previous)
          : {
              caller,
              incarnation,
              query,
              target,
              expires: now() + CONTENT_BOUNDS.ttlMs,
              afterSeq: 0,
              anchor: "pending",
              interleaved: false,
              messages: [],
            };
        let scanned = 0,
          synced = false;
        for await (const event of client.experimental.session.log(
          { sessionID, after: state.afterSeq, follow: false },
          { signal },
        )) {
          signal.throwIfAborted();
          if (event.type === "log.synced") {
            if (
              event.aggregateID !== sessionID ||
              (event.seq ?? 0) < state.afterSeq
            )
              return discontinuity(
                "Native activity history lost its sequence boundary",
              );
            state.afterSeq = event.seq ?? state.afterSeq;
            synced = true;
            break;
          }
          if (
            event.durable.aggregateID !== sessionID ||
            !Number.isSafeInteger(event.durable.seq) ||
            event.durable.seq <= state.afterSeq
          )
            return discontinuity("Native activity sequence or target changed");
          const assistantMessageID =
            "data" in event && "assistantMessageID" in event.data
              ? nativeID(event.data.assistantMessageID)
              : undefined;
          const isAnchor =
            event.type === "session.inbox.delivered" &&
            event.data.inboxID === sendID;
          const summary = {
            type: event.type,
            seq: event.durable.seq,
            ...(assistantMessageID ? { assistantMessageID } : {}),
          };
          if (
            (state.anchor === "delivered" || isAnchor) &&
            Buffer.byteLength(JSON.stringify([...output.events, summary])) >
              Math.floor((maxBytes - 512) / 2)
          ) {
            output.more = true;
            break;
          }
          state.afterSeq = event.durable.seq;
          scanned++;
          if (state.anchor === "pending" && assistantMessageID) {
            if (event.type === "session.step.started") {
              if (state.messages.length >= CONTENT_BOUNDS.pageItems)
                return discontinuity(
                  "Activity message backlog exceeds its bound; inspect a narrower boundary",
                );
              state.messages.push({
                id: assistantMessageID,
                offset: 0,
                delivered: false,
                ended: false,
              });
            } else if (
              event.type === "session.step.ended" ||
              event.type === "session.step.failed"
            )
              state.messages = state.messages.filter(
                (reference) => reference.id !== assistantMessageID,
              );
          }
          if (isAnchor) state.anchor = "delivered";
          if (state.anchor === "delivered") {
            if (
              event.type.startsWith("session.revert.") ||
              event.type.startsWith("session.compaction.") ||
              event.type === "session.deleted" ||
              event.type === "session.moved"
            )
              return discontinuity(
                "Native activity history changed after the send anchor",
              );
            if (event.type === "session.inbox.delivered" && !isAnchor)
              state.interleaved = true;
            output.events.push(summary);
            if (assistantMessageID) {
              let message = state.messages.find(
                (value) => value.id === assistantMessageID,
              );
              if (!message) {
                if (state.messages.length >= CONTENT_BOUNDS.pageItems)
                  return discontinuity(
                    "Activity message backlog exceeds its bound; inspect a narrower boundary",
                  );
                message = {
                  id: assistantMessageID,
                  offset: 0,
                  delivered: false,
                  ended: false,
                };
                state.messages.push(message);
              }
              if (
                event.type === "session.step.ended" ||
                event.type === "session.step.failed"
              )
                message.ended = true;
            }
          }
          if (scanned >= limit) {
            output.more = true;
            break;
          }
        }
        if (!synced && !output.more)
          return discontinuity(
            "Native activity replay ended without synchronization",
          );
        if (state.anchor === "pending" && synced) {
          const inbox = await client.session.inbox.list(
            { sessionID },
            { signal },
          );
          if (
            inbox.length > CONTENT_BOUNDS.pageItems ||
            !inbox.some(
              (item) => item.id === sendID && item.sessionID === sessionID,
            )
          )
            return discontinuity(
              "Send anchor is unavailable in native history or the pending inbox",
            );
        }
        output.anchor = state.anchor;
        output.afterSeq = state.afterSeq;
        output.interleaved = state.interleaved;
        for (const reference of state.anchor === "delivered"
          ? state.messages
          : []) {
          if (output.updates.length >= limit) {
            output.more = true;
            break;
          }
          const message = await client.session.message.get(
            { sessionID, messageID: reference.id },
            { signal },
          );
          if (message.id !== reference.id)
            return discontinuity("Tracked native message target changed");
          const serialized = JSON.stringify(message);
          if (Buffer.byteLength(serialized) > CONTENT_BOUNDS.nativeBytes)
            return discontinuity(
              "Tracked message exceeds its read bound; inspect it separately",
            );
          const version = fingerprint(message),
            changed = reference.version !== version;
          if (!changed && reference.delivered && reference.offset === 0)
            continue;
          if (changed) reference.delivered = false;
          const offset = changed ? 0 : reference.offset;
          const remaining =
            maxBytes - Buffer.byteLength(JSON.stringify(output)) - 160;
          if (remaining < 256) {
            output.more = true;
            break;
          }
          const update: MessageUpdate = {
            messageID: reference.id,
            version,
            replace: offset === 0 && reference.version !== undefined,
          };
          if (
            offset === 0 &&
            Buffer.byteLength(serialized) + 160 <= remaining
          ) {
            update.message = message;
            reference.delivered = true;
            reference.offset = 0;
          } else {
            update.encoding = "json-text";
            update.chunk = prefix(
              serialized.slice(offset),
              Math.floor((remaining - 160) / 2),
            );
            update.offsetChars = offset;
            reference.offset = offset + update.chunk.length;
            if (reference.offset >= serialized.length) {
              reference.offset = 0;
              reference.delivered = true;
            } else {
              reference.delivered = false;
              output.more = true;
            }
          }
          reference.version = version;
          output.updates.push(update);
        }
        state.messages = state.messages.filter(
          (reference) =>
            !(
              synced &&
              reference.ended &&
              reference.delivered &&
              reference.offset === 0
            ),
        );
        const after = await client.session.get({ sessionID }, { signal });
        if (
          fingerprint([
            after.id,
            after.projectID,
            after.agent,
            after.location,
            after.parentID,
            after.revert,
          ]) !== target
        )
          return discontinuity(
            "Selected activity target or history changed during read",
          );
        signal.throwIfAborted();
        if (disposed)
          return discontinuity("Activity reader was disposed during the read");
        for (const [key, value] of trackers)
          if (value.expires <= now()) trackers.delete(key);
        while (trackers.size >= CONTENT_BOUNDS.handles)
          trackers.delete(trackers.keys().next().value!);
        const cursor = randomUUID();
        state.expires = now() + CONTENT_BOUNDS.ttlMs;
        const result: TrackingPage = {
          ...output,
          available: true,
          status: "tracking",
          cursor,
        };
        if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
          return discontinuity(
            "Activity response exceeds its byte bound; narrow the read",
          );
        trackers.set(cursor, state);
        return result;
      } catch (error) {
        // Native errors can contain prompts or host credentials; expose no payloads.
        const kind =
          error instanceof Error &&
          ["Error", "TypeError", "RangeError", "AbortError"].includes(
            error.name,
          )
            ? error.name
            : "NativeError";
        return discontinuity(
          signal.aborted
            ? "Activity read was cancelled"
            : `Native session activity is unavailable (${kind}); restart tracking from the retained send ID`,
        );
      }
    },
    dispose() {
      disposed = true;
      handles.clear();
      trackers.clear();
    },
  };
}
