import type { OpenCodeClient, SessionInfo } from "@opencode/client";
import { isCoordinatorAgent } from "./coordinator-agent.ts";
import type { DiagnosticContext } from "./native-connection.ts";

export type NativeClient = OpenCodeClient;
export interface ProjectChoice {
  id: string;
  title: string;
  location: string;
}
export interface WorkerChoice {
  workerID: string;
  title: string;
  location: string;
  agent: string;
}
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
  form: Pick<NativeClient["form"], "list">;
  session: Pick<NativeClient["session"], "list" | "get" | "active"> & {
    inbox: Pick<NativeClient["session"]["inbox"], "list">;
  };
};
type AskFailurePhase = "permissions" | "forms";
type LocationForms = ReadonlyMap<
  string,
  Awaited<ReturnType<NativeClient["form"]["list"]>>["data"]
>;

async function readLocationForms(
  client: Pick<NativeSessionClient, "form">,
  location: string,
  signal?: AbortSignal,
): Promise<LocationForms> {
  const forms = await client.form.list(
    { location: { directory: location } },
    signal ? { signal } : undefined,
  );
  if (
    forms.location.directory !== location ||
    !Array.isArray(forms.data) ||
    forms.data.length > NATIVE_BOUNDS.catalogRows
  )
    throw new Error("Pending-form inventory is incomplete or mismatched");
  const ids = new Set<string>();
  const bySession = new Map<string, typeof forms.data>();
  for (const form of forms.data) {
    if (
      !form ||
      typeof form.id !== "string" ||
      !form.id.trim() ||
      typeof form.sessionID !== "string" ||
      !form.sessionID.trim() ||
      ids.has(form.id)
    )
      throw new Error("Pending-form identity is missing or duplicated");
    ids.add(form.id);
    const selected = bySession.get(form.sessionID) ?? [];
    selected.push(form);
    bySession.set(form.sessionID, selected);
  }
  return bySession;
}

export async function readNativeAsks(
  client: NativeAskClient,
  binding: { location: string; workerID: string },
  signal?: AbortSignal,
  permissionsSnapshot?: Promise<
    Awaited<ReturnType<NativeAskClient["permission"]["request"]["list"]>>
  >,
  onFailure?: (phase: AskFailurePhase) => void,
  formsSnapshot?: Promise<LocationForms>,
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
      formsSnapshot
        ? formsSnapshot.then((forms) => forms.get(binding.workerID) ?? [])
        : client.session.form.list({ sessionID: binding.workerID }, request),
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
    if (formsSnapshot) {
      asks.push(`form:${form.id}`);
      continue;
    }
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
  client: Omit<NativeSessionClient, "session" | "form"> & {
    session: Omit<NativeSessionClient["session"], "list">;
  },
  binding: { workerID: string; location: string; agent?: string },
  signal?: AbortSignal,
  snapshot?: {
    active: Awaited<ReturnType<NativeClient["session"]["active"]>>;
    permissions: Promise<
      Awaited<ReturnType<NativeAskClient["permission"]["request"]["list"]>>
    >;
    forms?: Promise<LocationForms>;
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
      snapshot?.forms,
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
    limit?: number;
    select?: (row: NativeInventory["sessions"][number]) => boolean;
  } = {},
  diagnostics?: DiagnosticContext,
): Promise<NativeInventory> {
  let phase = "list";
  try {
    const request = signal ? { signal } : undefined;
    const page = await client.session.list(
      {
        limit: Math.min(
          query.limit ?? NATIVE_BOUNDS.catalogRows,
          NATIVE_BOUNDS.catalogRows,
        ),
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
      page.data
        .map(sessionMetadata)
        .filter((row) => !query.select || query.select(row)),
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
  if (!rows.length) return [];
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
  const forms = new Map<string, Promise<LocationForms>>();
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
      if (!forms.has(location))
        forms.set(location, readLocationForms(client, location, signal));
      const state = await readNativeLiveState(
        client,
        {
          workerID: worker.id,
          location: worker.location,
          ...(worker.agent ? { agent: worker.agent } : {}),
        },
        signal,
        {
          active,
          permissions: permissions.get(location)!,
          forms: forms.get(location)!,
        },
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

export async function readNativeSessionDelivery(
  client: {
    session: Pick<NativeClient["session"], "get"> & {
      inbox: Pick<NativeClient["session"]["inbox"], "list">;
    };
    message: Pick<NativeClient["message"], "list">;
  },
  delivery: {
    id: string;
    sessionID: string;
    agent: string;
    location: string;
    operation?: string;
  },
  signal: AbortSignal,
): Promise<"admitted" | "unknown"> {
  if (signal.aborted) return "unknown";
  if (delivery.operation === "command" || delivery.operation === "skill")
    return "unknown";
  const expectedType =
    delivery.operation === "compact"
      ? "compaction"
      : delivery.operation === undefined || delivery.operation === "prompt"
        ? "user"
        : delivery.operation;
  try {
    const request = { signal };
    const worker = await client.session.get(
      { sessionID: delivery.sessionID },
      request,
    );
    if (
      worker.id !== delivery.sessionID ||
      worker.agent !== delivery.agent ||
      worker.location.directory !== delivery.location ||
      worker.time.archived
    )
      return "unknown";
    const inbox = await client.session.inbox.list(
      { sessionID: delivery.sessionID },
      request,
    );
    if (
      inbox.length > NATIVE_BOUNDS.catalogRows ||
      inbox.some((i) => i.sessionID !== delivery.sessionID)
    )
      return "unknown";
    const queued = inbox.filter((i) => i.id === delivery.id);
    if (queued.length)
      return queued.length === 1 &&
        queued[0]?.type === expectedType &&
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
          sessionID: delivery.sessionID,
          limit: NATIVE_BOUNDS.catalogRows,
          ...(cursor ? { cursor } : { order: "asc" as const }),
        },
        request,
      );
      for (const message of page.data) {
        if (seen.has(message.id) || seen.size >= NATIVE_BOUNDS.catalogRows)
          return "unknown";
        seen.add(message.id);
        if (message.id === delivery.id) {
          if (message.type !== expectedType) return "unknown";
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
