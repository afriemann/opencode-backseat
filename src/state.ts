import { createHash } from "node:crypto";

export const FOLLOW_BOUNDS = {
  followers: 128,
  requests: 400,
  notificationRequests: 128,
  notificationBytes: 16 * 1024,
  progressDelayMs: 500,
  retryMaxMs: 30_000,
} as const;
export const STATE_BOUNDS = {
  sessionDeliveries: 800,
  bytes: 8 * 1024 * 1024,
} as const;
export interface FollowRequest {
  kind: "permission" | "form";
  id: string;
}
export interface FollowPending {
  progress: number;
  idle: boolean;
  failed: boolean;
  requests: FollowRequest[];
  discontinuity: boolean;
}
export interface Follower {
  sessionID: string;
  coordinatorID: string;
  location: string;
  generation: string;
  afterSeq: number;
  idleSeq?: number;
  gone?: boolean;
  seenRequests: string[];
  pending: FollowPending;
}
export interface FollowNotification {
  id: string;
  coordinatorID: string;
  location: string;
  status: "reserved" | "admitted" | "uncertain";
  text: string;
  followers: { sessionID: string; generation: string }[];
}
export interface SessionDelivery {
  id: string;
  sessionID: string;
  location: string;
  agent?: string;
  parentID?: string;
  coordinatorID: string;
  serviceID: string;
  operation:
    | "prompt"
    | "synthetic"
    | "shell"
    | "compact"
    | "command"
    | "skill"
    | "create"
    | "import"
    | "delete";
  members?: string[];
  fingerprint: string;
  createdAt: number;
  status: "reserved" | "admitted" | "ambiguous";
  invocation?: { messageID: string; callID: string; createdAt: number };
}
export interface FollowerState {
  version: 3;
  retiredThrough?: number;
  followers: Follower[];
  sessionDeliveries: SessionDelivery[];
  notifications: FollowNotification[];
}
export function emptyPending(): FollowPending {
  return {
    progress: 0,
    idle: false,
    failed: false,
    requests: [],
    discontinuity: false,
  };
}
export function fingerprint(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Unfingerprintable evidence");
  return createHash("sha256").update(encoded).digest("hex");
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_000)
    throw new Error("Invalid bounded text");
  return value;
}
export function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new Error("Invalid counter");
  return value;
}
export function list<T>(value: unknown, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid list");
  return value.map(parse);
}
export function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unknown input field");
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid event flag");
  return value;
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length)
    throw new Error("Duplicate durable identity");
}
function boundedList<T>(
  value: unknown,
  maximum: number,
  parse: (entry: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error("Durable inventory capacity exhausted");
  return value.map(parse);
}
function digest(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("Invalid digest");
  return result;
}
function parseSessionDelivery(value: unknown): SessionDelivery {
  const v = object(value);
  exact(v, [
    "id",
    "sessionID",
    "location",
    "agent",
    "parentID",
    "coordinatorID",
    "serviceID",
    "operation",
    "fingerprint",
    "createdAt",
    "status",
    "invocation",
    "members",
  ]);
  if (
    ![
      "prompt",
      "synthetic",
      "shell",
      "compact",
      "command",
      "skill",
      "create",
      "import",
      "delete",
    ].includes(String(v.operation)) ||
    !["reserved", "admitted", "ambiguous"].includes(String(v.status))
  )
    throw new Error("Invalid session delivery operation or status");
  const id = text(v.id);
  if (id.length > 200) throw new Error("Oversized session delivery ID");
  const invocation =
    v.invocation === undefined ? undefined : object(v.invocation);
  if (invocation) exact(invocation, ["messageID", "callID", "createdAt"]);
  const members = v.members === undefined ? undefined : list(v.members, text);
  if (
    (v.operation === "delete") !== (members !== undefined) ||
    (members &&
      (!members.length ||
        members.length > FOLLOW_BOUNDS.followers ||
        new Set(members).size !== members.length ||
        !members.includes(text(v.sessionID))))
  )
    throw new Error("Invalid deletion members");
  return {
    id,
    sessionID: text(v.sessionID),
    location: text(v.location),
    ...(v.agent === undefined ? {} : { agent: text(v.agent) }),
    ...(v.parentID === undefined ? {} : { parentID: text(v.parentID) }),
    coordinatorID: text(v.coordinatorID),
    serviceID: text(v.serviceID),
    operation: v.operation as SessionDelivery["operation"],
    fingerprint: digest(v.fingerprint),
    createdAt: integer(v.createdAt),
    status: v.status as SessionDelivery["status"],
    ...(members === undefined ? {} : { members }),
    ...(invocation
      ? {
          invocation: {
            messageID: text(invocation.messageID),
            callID: text(invocation.callID),
            createdAt: integer(invocation.createdAt),
          },
        }
      : {}),
  };
}
export function parseFollowerState(value: unknown): FollowerState {
  if (value === undefined)
    return {
      version: 3,
      followers: [],
      sessionDeliveries: [],
      notifications: [],
    };
  const v = object(value);
  exact(v, [
    "version",
    "followers",
    "sessionDeliveries",
    "notifications",
    "retiredThrough",
  ]);
  if (v.version !== 3)
    throw new Error("Unsupported durable state; task stores are not migrated");
  if (Buffer.byteLength(JSON.stringify(value)) > STATE_BOUNDS.bytes)
    throw new Error("Durable inventory byte capacity exhausted");
  const followers = boundedList(
    v.followers,
    FOLLOW_BOUNDS.followers,
    (entry): Follower => {
      const f = object(entry);
      exact(f, [
        "sessionID",
        "coordinatorID",
        "location",
        "generation",
        "afterSeq",
        "idleSeq",
        "gone",
        "seenRequests",
        "pending",
      ]);
      const p = object(f.pending);
      exact(p, ["progress", "idle", "failed", "requests", "discontinuity"]);
      const requests = boundedList(
        p.requests,
        FOLLOW_BOUNDS.requests,
        (entry): FollowRequest => {
          const request = object(entry);
          exact(request, ["kind", "id"]);
          if (request.kind !== "permission" && request.kind !== "form")
            throw new Error("Invalid request kind");
          return { kind: request.kind, id: text(request.id) };
        },
      );
      unique(requests.map((request) => `${request.kind}:${request.id}`));
      const seenRequests = boundedList(
        f.seenRequests,
        FOLLOW_BOUNDS.requests,
        text,
      );
      unique(seenRequests);
      return {
        sessionID: text(f.sessionID),
        coordinatorID: text(f.coordinatorID),
        location: text(f.location),
        generation: text(f.generation),
        afterSeq: integer(f.afterSeq),
        ...(f.idleSeq === undefined ? {} : { idleSeq: integer(f.idleSeq) }),
        ...(f.gone === undefined ? {} : { gone: flag(f.gone) }),
        seenRequests,
        pending: {
          progress: integer(p.progress),
          idle: flag(p.idle),
          failed: flag(p.failed),
          requests,
          discontinuity: flag(p.discontinuity),
        },
      };
    },
  );
  unique(followers.map((follower) => follower.sessionID));
  const owners = new Map(
    followers.map((follower) => [follower.sessionID, follower.coordinatorID]),
  );
  for (const follower of followers) {
    const seen = new Set([follower.sessionID]);
    let owner: string | undefined = follower.coordinatorID;
    while (owner !== undefined) {
      if (seen.has(owner)) throw new Error("Following cycle");
      seen.add(owner);
      owner = owners.get(owner);
    }
  }
  const notifications = boundedList(
    v.notifications,
    FOLLOW_BOUNDS.followers,
    (entry): FollowNotification => {
      const n = object(entry);
      exact(n, [
        "id",
        "coordinatorID",
        "location",
        "status",
        "text",
        "followers",
      ]);
      if (
        n.status !== "reserved" &&
        n.status !== "admitted" &&
        n.status !== "uncertain"
      )
        throw new Error("Invalid notification status");
      const content = text(n.text);
      if (Buffer.byteLength(content) > FOLLOW_BOUNDS.notificationBytes)
        throw new Error("Oversized notification");
      const refs = boundedList(
        n.followers,
        FOLLOW_BOUNDS.followers,
        (entry) => {
          const reference = object(entry);
          exact(reference, ["sessionID", "generation"]);
          return {
            sessionID: text(reference.sessionID),
            generation: text(reference.generation),
          };
        },
      );
      if (!refs.length) throw new Error("Notification has no followed session");
      unique(refs.map((reference) => reference.sessionID));
      return {
        id: text(n.id),
        coordinatorID: text(n.coordinatorID),
        location: text(n.location),
        status: n.status,
        text: content,
        followers: refs,
      };
    },
  );
  unique(notifications.map((notification) => notification.coordinatorID));
  const sessionDeliveries = boundedList(
    v.sessionDeliveries,
    STATE_BOUNDS.sessionDeliveries,
    parseSessionDelivery,
  );
  unique([
    ...sessionDeliveries.map((delivery) => delivery.id),
    ...notifications.map((notification) => notification.id),
  ]);
  return {
    version: 3,
    followers,
    sessionDeliveries,
    notifications,
    ...(v.retiredThrough === undefined
      ? {}
      : { retiredThrough: integer(v.retiredThrough) }),
  };
}
