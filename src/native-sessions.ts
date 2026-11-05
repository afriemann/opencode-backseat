import type { OpenCodeClient, SessionInfo } from "@opencode/client";
import { isCoordinatorAgent } from "./coordinator-agent.ts";
import type { WorkerBinding } from "./state.ts";
import type { DispatchIntent } from "./dispatch.ts";
import type { ProjectChoice, WorkerChoice } from "./ui.ts";
import type { DiagnosticContext } from "./native-connection.ts";

export type NativeClient = OpenCodeClient;
export const NATIVE_BOUNDS = Object.freeze({
  catalogRows: 200,
  concurrentReads: 8,
});
export interface NativeCatalogClient {
  project: Pick<NativeClient["project"], "list">;
  agent: Pick<NativeClient["agent"], "list">;
  session: Pick<NativeClient["session"], "list">;
}
export interface NativeAskClient {
  permission: { request: Pick<NativeClient["permission"]["request"], "list"> };
  session: { form: Pick<NativeClient["session"]["form"], "list" | "get"> };
}
export type NativeSessionClient = NativeAskClient & {
  session: Pick<NativeClient["session"], "list" | "get" | "active"> & {
    inbox: Pick<NativeClient["session"]["inbox"], "list">;
  };
};
type AskFailurePhase = "permissions" | "forms";

export async function readNativeAsks(
  client: NativeAskClient,
  binding: Pick<WorkerBinding, "location" | "workerID">,
  signal?: AbortSignal,
  permissionsSnapshot?: Promise<
    Awaited<ReturnType<NativeAskClient["permission"]["request"]["list"]>>
  >,
  onFailure?: (phase: AskFailurePhase) => void,
): Promise<readonly string[]> {
  const diagnosed = <T>(
    work: Promise<T>,
    phase: AskFailurePhase,
  ): Promise<T> => {
    if (!onFailure) return work;
    return work.catch((error) => {
      try {
        onFailure(phase);
      } catch {
        /* Diagnostics preserve the native failure. */
      }
      throw error;
    });
  };
  const request = signal ? { signal } : undefined;
  const [permissions, forms] = await Promise.all([
    diagnosed(
      permissionsSnapshot ??
        client.permission.request.list(
          { location: { directory: binding.location } },
          request,
        ),
      "permissions",
    ),
    diagnosed(
      client.session.form.list({ sessionID: binding.workerID }, request),
      "forms",
    ),
  ]);
  if (
    permissions.location.directory !== binding.location ||
    permissions.data.length > NATIVE_BOUNDS.catalogRows ||
    forms.length > NATIVE_BOUNDS.catalogRows ||
    forms.some((f) => f.sessionID !== binding.workerID)
  )
    throw new Error("Pending-input inventory is incomplete or mismatched");
  const asks = permissions.data
    .filter((r) => r.sessionID === binding.workerID)
    .map((r) => `permission:${r.id}`);
  for (const form of forms) {
    const detail = await diagnosed(
      client.session.form.get(
        { sessionID: binding.workerID, formID: form.id },
        request,
      ),
      "forms",
    );
    if (detail.id !== form.id || detail.sessionID !== binding.workerID)
      throw new Error("Form inventory does not match the selected worker");
    if (detail.state.status === "pending") asks.push(`form:${form.id}`);
  }
  return asks;
}

export class NativeDiscovery {
  constructor(
    private readonly client: NativeCatalogClient,
    private readonly signal?: AbortSignal,
  ) {}
  async projects(): Promise<
    readonly (ProjectChoice & { projectID: string })[]
  > {
    const projects = await this.client.project.list(
      { archived: false },
      this.signal ? { signal: this.signal } : undefined,
    );
    const pathName = (path: string) =>
      path.split("/").filter(Boolean).at(-1) ?? path;
    const choices = projects.flatMap((p) =>
      [...new Set([p.canonical, ...p.sandboxes])].map((location) => ({
        id: JSON.stringify([p.id, location]),
        projectID: p.id,
        title:
          location === p.canonical
            ? (p.name ?? pathName(location))
            : `${p.name ?? pathName(p.canonical)} / ${pathName(location)}`,
        location,
      })),
    );
    if (
      choices.length > NATIVE_BOUNDS.catalogRows ||
      choices.some((c) => !c.location.startsWith("/"))
    )
      throw new Error("Project discovery is incomplete or unsupported");
    return choices;
  }
  async agents(location: string): Promise<readonly string[]> {
    const result = await this.client.agent.list(
      { location: { directory: location } },
      this.signal ? { signal: this.signal } : undefined,
    );
    if (
      result.location.directory !== location ||
      result.data.length > NATIVE_BOUNDS.catalogRows
    )
      throw new Error("Agent discovery does not match the selected location");
    return result.data
      .filter(
        (agent) =>
          !agent.hidden &&
          agent.mode !== "subagent" &&
          !isCoordinatorAgent(agent),
      )
      .map((agent) => agent.id);
  }
  async workers(
    location: string,
    agent: string,
  ): Promise<readonly WorkerChoice[]> {
    const workers: WorkerChoice[] = [],
      cursors = new Set<string>();
    let cursor: string | undefined,
      seen = 0;
    do {
      const page = await this.client.session.list(
        { directory: location, archived: false, ...(cursor ? { cursor } : {}) },
        this.signal ? { signal: this.signal } : undefined,
      );
      seen += page.data.length;
      if (seen > NATIVE_BOUNDS.catalogRows)
        throw new Error("Worker discovery exceeds its bound");
      for (const w of page.data)
        if (
          w.location.directory === location &&
          w.agent === agent &&
          w.parentID === undefined &&
          !w.time.archived
        )
          workers.push({
            workerID: w.id,
            title: w.title ?? w.id,
            location,
            agent,
          });
      cursor = page.cursor.next ?? undefined;
      if (cursor && cursors.has(cursor))
        throw new Error("Worker discovery is incomplete");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return workers;
  }
}

export async function readNativeLiveState(
  client: Omit<NativeSessionClient, "session"> & {
    session: Omit<NativeSessionClient["session"], "list">;
  },
  binding: { workerID: string; location: string; agent?: string },
  signal?: AbortSignal,
  snapshot?: {
    active: Awaited<ReturnType<NativeClient["session"]["active"]>>;
    permissions: Promise<
      Awaited<ReturnType<NativeAskClient["permission"]["request"]["list"]>>
    >;
  },
  onAskFailure?: (phase: AskFailurePhase) => void,
): Promise<{
  worker: Awaited<ReturnType<NativeClient["session"]["get"]>>;
  active: Awaited<ReturnType<NativeClient["session"]["active"]>>;
  asks: readonly string[];
  inbox: Awaited<ReturnType<NativeClient["session"]["inbox"]["list"]>>;
}> {
  const request = signal ? { signal } : undefined;
  const [worker, active, asks, inbox] = await Promise.all([
    client.session.get({ sessionID: binding.workerID }, request),
    snapshot
      ? Promise.resolve(snapshot.active)
      : client.session.active(request),
    readNativeAsks(
      client,
      binding,
      signal,
      snapshot?.permissions,
      onAskFailure,
    ),
    client.session.inbox.list({ sessionID: binding.workerID }, request),
  ]);
  if (
    worker.id !== binding.workerID ||
    worker.location.directory !== binding.location ||
    worker.agent !== binding.agent ||
    worker.time.archived !== undefined ||
    inbox.length > NATIVE_BOUNDS.catalogRows ||
    inbox.some((i) => i.sessionID !== binding.workerID)
  )
    throw new Error("Unreadable or mismatched worker inventory");
  return { worker, active, asks, inbox };
}
export interface NativeInventory {
  available: boolean;
  partial: boolean;
  reason?: string;
  cursor?: string;
  sessions: {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    projectID: string;
    parentID: string | null;
    topLevel: boolean;
    archived: boolean;
    location: string;
    agent?: string;
    status: "running" | "waiting-for-input" | "inactive" | "unknown";
  }[];
}
export async function readNativeInventory(
  client: NativeSessionClient,
  cursor?: string,
  signal?: AbortSignal,
  query: {
    projectID?: string;
    location?: string;
    search?: string;
    parentID?: string | null;
    includeArchived?: boolean;
    order?: "asc" | "desc";
  } = {},
  diagnostics?: DiagnosticContext,
): Promise<NativeInventory> {
  let phase = "list";
  try {
    const request = signal ? { signal } : undefined;
    const page = await client.session.list(
      {
        limit: NATIVE_BOUNDS.catalogRows,
        ...(query.includeArchived ? {} : { archived: false }),
        ...(query.projectID !== undefined ? { project: query.projectID } : {}),
        ...(query.location !== undefined ? { directory: query.location } : {}),
        ...(query.search !== undefined ? { search: query.search } : {}),
        ...(query.parentID !== undefined ? { parentID: query.parentID } : {}),
        ...(query.order !== undefined ? { order: query.order } : {}),
        ...(cursor ? { cursor } : {}),
      },
      request,
    );
    if (
      page.data.length > NATIVE_BOUNDS.catalogRows ||
      new Set(page.data.map((w) => w.id)).size !== page.data.length
    )
      throw new Error("Incomplete native inventory");
    phase = "refresh";
    const sessions = await refreshNativeSessions(
      client,
      page.data.map(sessionMetadata),
      signal,
      diagnostics,
    );
    const next = page.cursor.next ?? undefined;
    diagnostics?.emit("debug", "inventory.completed", {
      phase,
      count: sessions.length,
      continuation: Boolean(next),
    });
    return {
      available: true,
      partial: Boolean(next) || sessions.some((s) => s.status === "unknown"),
      ...(next ? { cursor: next } : {}),
      sessions,
    };
  } catch {
    signal?.throwIfAborted();
    diagnostics?.emit("warn", "inventory.degraded", {
      phase,
      classification: "unavailable",
      continuation: Boolean(cursor),
    });
    return {
      available: false,
      partial: true,
      sessions: [],
      reason: "Native session inventory unavailable",
    };
  }
}

function sessionMetadata(
  worker: SessionInfo,
): NativeInventory["sessions"][number] {
  return {
    id: worker.id,
    title: worker.title ?? worker.id,
    createdAt: worker.time.created,
    updatedAt: worker.time.updated,
    projectID: worker.projectID,
    parentID: worker.parentID ?? null,
    topLevel: worker.parentID === undefined,
    archived: worker.time.archived !== undefined,
    location: worker.location.directory,
    ...(worker.agent ? { agent: worker.agent } : {}),
    status: "unknown",
  };
}

export async function refreshNativeSessions(
  client: NativeSessionClient,
  rows: readonly NativeInventory["sessions"][number][],
  signal?: AbortSignal,
  diagnostics?: DiagnosticContext,
): Promise<NativeInventory["sessions"]> {
  if (rows.length > NATIVE_BOUNDS.catalogRows)
    throw new Error("Native inventory exceeds its bound");
  const request = signal ? { signal } : undefined;
  const sessions: NativeInventory["sessions"] = [];
  const askFailures: Record<AskFailurePhase, number> = {
    permissions: 0,
    forms: 0,
  };
  const active = await client.session.active(request).catch(() => undefined);
  const permissions = new Map<
    string,
    Promise<
      Awaited<ReturnType<NativeAskClient["permission"]["request"]["list"]>>
    >
  >();
  const read = async (
    worker: NativeInventory["sessions"][number],
  ): Promise<NativeInventory["sessions"][number]> => {
    let status: NativeInventory["sessions"][number]["status"] = "unknown";
    let metadata = worker;
    try {
      if (!active) throw new Error("Native activity unavailable");
      const location = worker.location;
      if (!permissions.has(location))
        permissions.set(
          location,
          client.permission.request.list(
            { location: { directory: location } },
            request,
          ),
        );
      const state = await readNativeLiveState(
        client,
        {
          workerID: worker.id,
          location: worker.location,
          ...(worker.agent ? { agent: worker.agent } : {}),
        },
        signal,
        { active, permissions: permissions.get(location)! },
        (phase) => {
          askFailures[phase]++;
        },
      );
      metadata = sessionMetadata(state.worker);
      status = state.asks.length
        ? "waiting-for-input"
        : active[worker.id]?.type === "running"
          ? "running"
          : state.inbox.length || active[worker.id]
            ? "unknown"
            : "inactive";
    } catch {
      signal?.throwIfAborted();
    }
    return {
      ...metadata,
      status,
    };
  };
  for (
    let offset = 0;
    offset < rows.length;
    offset += NATIVE_BOUNDS.concurrentReads
  ) {
    sessions.push(
      ...(await Promise.all(
        rows.slice(offset, offset + NATIVE_BOUNDS.concurrentReads).map(read),
      )),
    );
  }
  const after = await client.session.active(request).catch(() => undefined);
  for (const session of sessions)
    if (
      !active ||
      !after ||
      JSON.stringify(active[session.id]) !== JSON.stringify(after[session.id])
    )
      session.status = "unknown";
  signal?.throwIfAborted();
  const unknownCount = sessions.filter(
    (session) => session.status === "unknown",
  ).length;
  for (const phase of ["permissions", "forms"] as const)
    if (askFailures[phase])
      diagnostics?.emit("warn", "refresh.degraded", {
        phase,
        count: askFailures[phase],
        classification: "unavailable",
      });
  diagnostics?.emit(
    unknownCount ? "warn" : "debug",
    unknownCount ? "refresh.degraded" : "refresh.completed",
    {
      phase: !active || !after ? "activity" : "refresh",
      ...(unknownCount ? { classification: "unavailable" } : {}),
      count: sessions.length,
      unknownCount,
    },
  );
  return sessions;
}

export async function readNativeDelivery(
  client: {
    session: Pick<NativeClient["session"], "get"> & {
      inbox: Pick<NativeClient["session"]["inbox"], "list">;
    };
    message: Pick<NativeClient["message"], "list">;
  },
  binding: WorkerBinding,
  intent: DispatchIntent,
  signal: AbortSignal,
): Promise<"admitted" | "unknown"> {
  if (
    binding.id !== intent.taskID ||
    binding.workerID !== intent.workerID ||
    signal.aborted
  )
    return "unknown";
  try {
    const request = { signal };
    const worker = await client.session.get(
      { sessionID: intent.workerID },
      request,
    );
    if (
      worker.id !== intent.workerID ||
      worker.agent !== binding.agent ||
      worker.location.directory !== binding.location ||
      worker.time.archived
    )
      return "unknown";
    const inbox = await client.session.inbox.list(
      { sessionID: intent.workerID },
      request,
    );
    if (
      inbox.length > NATIVE_BOUNDS.catalogRows ||
      inbox.some((i) => i.sessionID !== intent.workerID)
    )
      return "unknown";
    const queued = inbox.filter((i) => i.id === intent.id);
    if (queued.length)
      return queued.length === 1 &&
        queued[0]?.type === "user" &&
        !signal.aborted
        ? "admitted"
        : "unknown";
    const seen = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | undefined,
      delivered = false;
    do {
      const page = await client.message.list(
        {
          sessionID: intent.workerID,
          limit: NATIVE_BOUNDS.catalogRows,
          ...(cursor ? { cursor } : { order: "asc" as const }),
        },
        request,
      );
      for (const message of page.data) {
        if (seen.has(message.id) || seen.size >= NATIVE_BOUNDS.catalogRows)
          return "unknown";
        seen.add(message.id);
        if (message.id === intent.id) {
          if (message.type !== "user") return "unknown";
          delivered = true;
        }
      }
      cursor = page.cursor.next ?? undefined;
      if (cursor && cursors.has(cursor)) return "unknown";
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return delivered && !signal.aborted ? "admitted" : "unknown";
  } catch {
    return "unknown";
  }
}
