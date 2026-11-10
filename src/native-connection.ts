import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { fallback, headers } from "@opencode/client/service";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { BackseatRpc } from "./rpc.ts";

export const DIAGNOSTIC_EVENTS = [
  "setup.started",
  "setup.completed",
  "setup.failed",
  "setup.degraded",
  "cleanup.completed",
  "cleanup.failed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "rpc.started",
  "rpc.completed",
  "rpc.failed",
  "native.started",
  "native.completed",
  "native.failed",
  "native.request.completed",
  "native.request.failed",
  "native.request.suppressed",
  "native.requests.deadline",
  "native.request.active",
  "inventory.completed",
  "inventory.degraded",
  "refresh.completed",
  "refresh.degraded",
  "observer.degraded",
  "observer.failed",
  "catalog.failed",
] as const;
export const DIAGNOSTIC_PHASES = [
  "registration",
  "client",
  "service",
  "incarnation",
  "revalidation",
  "operation",
  "completion",
  "list",
  "activity",
  "permissions",
  "forms",
  "refresh",
  "stream",
  "shutdown",
  "intake",
] as const;
export const DIAGNOSTIC_FAILURES = [
  "timeout",
  "disposed",
  "cancelled",
  "validation",
  "transport",
  "unavailable",
  "unknown",
] as const;
export type DiagnosticLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticEmitter = (
  level: DiagnosticLevel,
  event: (typeof DIAGNOSTIC_EVENTS)[number],
  fields?: Record<string, unknown>,
) => void;
export type DiagnosticOperation =
  | "setup"
  | "cleanup"
  | "tool"
  | "rpc"
  | "native"
  | "inventory"
  | "refresh"
  | "observer";

export class DiagnosticToken {
  readonly #value = randomUUID();
  static read(token: DiagnosticToken): string {
    return token.#value;
  }
}
export interface DiagnosticContext {
  emit: DiagnosticEmitter;
}
export function diagnosticContext(
  diagnostics: DiagnosticEmitter | undefined,
  operation: DiagnosticOperation,
  action?: string,
): DiagnosticContext {
  let correlation: DiagnosticToken | undefined;
  try {
    correlation = new DiagnosticToken();
  } catch {
    /* Diagnostics cannot block work. */
  }
  const started = performance.now();
  return {
    emit(level, event, fields) {
      try {
        diagnostics?.(level, event, {
          ...fields,
          operation,
          action,
          correlation,
          durationMs: performance.now() - started,
        });
      } catch {
        /* Injected emitters are not trusted to preserve outcomes. */
      }
    },
  };
}

const REGISTRATION_BYTES = 16_384;
const REQUEST_TIMEOUT = 10_000;
const REQUEST_DIAGNOSTIC_LIMIT = 32;
const REQUEST_CATEGORIES = [
  "info",
  "identity",
  "projects",
  "agents",
  "sessions",
  "activity",
  "session",
  "permissions",
  "forms",
  "form",
  "inbox",
  "messages",
  "unknown",
] as const;
type RequestCategory = (typeof REQUEST_CATEGORIES)[number];
const REQUEST_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ABORT_ERR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "unknown",
] as const;

function ownData(value: unknown, key: string): unknown {
  try {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    // Error objects and diagnostic inputs may be proxies; their contents are optional.
    return undefined;
  }
}

export function projectRequestDiagnostics(
  fields: unknown,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, values] of [
    ["requestCategory", REQUEST_CATEGORIES],
    ["errorCode", REQUEST_ERROR_CODES],
  ] as const) {
    const value = ownData(fields, key);
    if (
      typeof value === "string" &&
      (values as readonly string[]).includes(value)
    )
      record[key] = value;
  }
  const duration = ownData(fields, "requestDurationMs");
  if (
    typeof duration === "number" &&
    Number.isFinite(duration) &&
    duration >= 0
  )
    record.requestDurationMs = duration;
  const status = ownData(fields, "httpStatus");
  if (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
  )
    record.httpStatus = status;
  const count = ownData(fields, "count");
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
    record.count = count;
  return record;
}

function requestCategory(method: string, pathname: string): RequestCategory {
  if (method === "POST" && pathname === `/api/rpc/${BackseatRpc.id}/identity`)
    return "identity";
  if (method !== "GET") return "unknown";
  for (const [path, category] of [
    ["/api/info", "info"],
    ["/api/project", "projects"],
    ["/api/agent", "agents"],
    ["/api/session", "sessions"],
    ["/api/session/active", "activity"],
    ["/api/permission/request", "permissions"],
  ] as const) {
    if (pathname === path) return category;
  }
  for (const [pattern, category] of [
    [/^\/api\/session\/[^/]+\/form\/[^/]+$/, "form"],
    [/^\/api\/session\/[^/]+\/form$/, "forms"],
    [/^\/api\/session\/[^/]+\/inbox$/, "inbox"],
    [/^\/api\/session\/[^/]+\/message$/, "messages"],
    [/^\/api\/session\/[^/]+$/, "session"],
  ] as const) {
    if (pattern.test(pathname)) return category;
  }
  return "unknown";
}

function requestErrorCode(error: unknown): string {
  for (const candidate of [error, ownData(error, "cause")]) {
    const code = ownData(candidate, "code");
    if (
      typeof code === "string" &&
      (REQUEST_ERROR_CODES as readonly string[]).includes(code)
    )
      return code;
  }
  return "unknown";
}

function requestDiagnostics(diagnostics: DiagnosticContext) {
  const active = new Set<{ category: RequestCategory; started: number }>();
  const suppressed = new Map<RequestCategory, number>();
  let terminalCount = 0;
  let closed = false;
  const emit = (
    event: Parameters<DiagnosticEmitter>[1],
    fields: Record<string, unknown>,
    level: DiagnosticLevel = "warn",
  ) => {
    try {
      if (!closed)
        diagnostics.emit(level, event, projectRequestDiagnostics(fields));
    } catch {
      /* Diagnostic processing must not replace a native result or error. */
    }
  };
  return {
    start(method: string, pathname: string) {
      if (closed) return () => undefined;
      const entry = {
        category: requestCategory(method, pathname),
        started: performance.now(),
      };
      active.add(entry);
      return (
        status?: number,
        error?: unknown,
        failed = false,
        exception = false,
      ) => {
        try {
          active.delete(entry);
          if (closed) return;
          if (terminalCount++ >= REQUEST_DIAGNOSTIC_LIMIT) {
            if (failed)
              suppressed.set(
                entry.category,
                (suppressed.get(entry.category) ?? 0) + 1,
              );
            return;
          }
          emit(
            failed ? "native.request.failed" : "native.request.completed",
            {
              requestCategory: entry.category,
              requestDurationMs: performance.now() - entry.started,
              httpStatus: status,
              ...(exception ? { errorCode: requestErrorCode(error) } : {}),
            },
            failed ? "warn" : "debug",
          );
        } catch {
          /* Optional timing or classification cannot replace the transport outcome. */
        }
      };
    },
    deadline() {
      emit("native.requests.deadline", { count: active.size });
      const now = performance.now();
      for (const category of REQUEST_CATEGORIES) {
        let count = 0;
        let oldest = now;
        for (const entry of active)
          if (entry.category === category) {
            count++;
            oldest = Math.min(oldest, entry.started);
          }
        if (count)
          emit("native.request.active", {
            requestCategory: category,
            count,
            requestDurationMs: now - oldest,
          });
      }
    },
    close() {
      for (const [category, count] of suppressed)
        emit("native.request.suppressed", { requestCategory: category, count });
      closed = true;
      active.clear();
      suppressed.clear();
    },
  };
}
const hasUnsafeOtherWrite = (mode: number): boolean =>
  (mode & 0o002) !== 0 && (mode & 0o1000) === 0;
export type NativeFailureClass =
  "timeout" | "cancelled" | "disposed" | "unavailable" | "validation";
export class NativeConnectionError extends Error {
  readonly classification: NativeFailureClass;
  constructor(
    message: string,
    classification: NativeFailureClass = "validation",
  ) {
    super(message);
    this.classification = classification;
  }
}
const unavailable = (
  reason: string,
  classification?: NativeFailureClass,
): Error =>
  new NativeConnectionError(`Native service ${reason}`, classification);

// Read the registered native endpoint without invoking the SDK's credentialed probe.
export async function readNativeRegistration(
  file = fallback(),
  files: Pick<typeof fs, "lstat" | "open"> = fs,
): Promise<unknown> {
  if (
    !isAbsolute(file) ||
    resolve(file) !== file ||
    process.getuid === undefined
  )
    throw unavailable("registration is unsupported");
  const uid = process.getuid();
  const ancestors: { path: string; dev: number; ino: number }[] = [];
  for (let path = dirname(file); ; path = dirname(path)) {
    const info = await files.lstat(path);
    const directory = `registration directory ${JSON.stringify(path)}`;
    const mode = (info.mode & 0o7777).toString(8).padStart(4, "0");
    if (!info.isDirectory())
      throw unavailable(
        `${directory} is ${info.isSymbolicLink() ? "a symbolic link, not a directory" : "not a directory"} (mode ${mode}). Review this path's type; registration ancestors must be directories.`,
      );
    if (![0, uid].includes(info.uid))
      throw unavailable(
        `${directory} is owned by UID ${info.uid} (expected UID 0 or ${uid}). Review this directory's ownership.`,
      );
    if (hasUnsafeOtherWrite(info.mode)) {
      throw unavailable(
        `${directory} is other-writable without sticky protection (mode ${mode}). Review this directory's permissions.`,
      );
    }
    ancestors.push({ path, dev: info.dev, ino: info.ino });
    if (path === dirname(path)) break;
  }
  const before = await files.lstat(file);
  if (
    !before.isFile() ||
    before.uid !== uid ||
    (before.mode & 0o077) !== 0 ||
    before.nlink !== 1 ||
    before.size > REGISTRATION_BYTES
  )
    throw unavailable("registration is unsafe");
  const handle = await files.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !opened.isFile() ||
      opened.uid !== uid ||
      (opened.mode & 0o077) !== 0 ||
      opened.nlink !== 1
    )
      throw unavailable("registration changed");
    const buffer = Buffer.alloc(REGISTRATION_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > REGISTRATION_BYTES)
      throw unavailable("registration is oversized");
    const after = await handle.stat(),
      named = await files.lstat(file);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== length ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.isSymbolicLink()
    )
      throw unavailable("registration changed");
    for (const ancestor of ancestors) {
      const info = await files.lstat(ancestor.path);
      if (
        !info.isDirectory() ||
        info.dev !== ancestor.dev ||
        info.ino !== ancestor.ino ||
        ![0, uid].includes(info.uid) ||
        hasUnsafeOtherWrite(info.mode)
      )
        throw unavailable("registration ancestry changed");
    }
    return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

function registration(
  value: unknown,
  version: string,
): { origin: string; password?: string; fingerprint: string } {
  if (!value || typeof value !== "object")
    throw unavailable("registration unavailable");
  const v = value as Record<string, unknown>;
  if (
    v.pid !== process.pid ||
    v.version !== version ||
    typeof v.url !== "string" ||
    (v.password !== undefined && typeof v.password !== "string") // pragma: allowlist secret - type-name comparison, not a credential.
  )
    throw unavailable("registration does not match this host");
  const url = new URL(v.url);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw unavailable("destination is unsafe");
  return {
    origin: url.origin,
    ...(v.password === undefined ? {} : { password: v.password as string }),
    fingerprint: JSON.stringify(value),
  };
}

export interface NativeConnection {
  read<T>(
    operation: (client: OpenCodeClient, signal: AbortSignal) => Promise<T>,
    diagnostics?: DiagnosticContext,
  ): Promise<T>;
  identity(input: { nonce: string; origin: string }): { mac: string };
  dispose(): void;
}

export function createNativeConnection(options: {
  location: string;
  version: string;
  registration?: () => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  diagnostics?: DiagnosticEmitter;
}): NativeConnection {
  const lifetime = new AbortController();
  const secret = randomBytes(32);
  const source = options.registration ?? readNativeRegistration;
  const transport = options.fetch ?? globalThis.fetch;
  const identity = ({
    nonce,
    origin,
  }: {
    nonce: string;
    origin: string;
  }): { mac: string } => {
    lifetime.signal.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(nonce) || origin.length > 200)
      throw unavailable("identity challenge is invalid");
    return {
      mac: createHmac("sha256", secret)
        .update(
          JSON.stringify([
            "backseat-native-instance",
            nonce,
            origin,
            options.location,
            options.version,
          ]),
        )
        .digest("hex"),
    };
  };
  return {
    async read(operation, context) {
      const diagnostics =
        context ?? diagnosticContext(options.diagnostics, "native");
      let phase: (typeof DIAGNOSTIC_PHASES)[number] = "registration";
      let deadline: AbortSignal | undefined;
      let callerSignal: AbortSignal | undefined;
      let transportFailed = false;
      const requests = requestDiagnostics(diagnostics);
      const onDeadline = () => {
        try {
          requests.deadline();
        } catch {
          /* Deadline diagnostics cannot interfere with abort delivery. */
        }
      };
      diagnostics.emit("debug", "native.started", { phase });
      try {
        lifetime.signal.throwIfAborted();
        const registered = registration(await source(), options.version);
        deadline = AbortSignal.timeout(REQUEST_TIMEOUT);
        deadline.addEventListener("abort", onDeadline, { once: true });
        const signal = AbortSignal.any([lifetime.signal, deadline]);
        phase = "client";
        const guarded: typeof fetch = Object.assign(
          async (input: string | URL | Request, init?: RequestInit) => {
            const request = new Request(input, init);
            callerSignal = request.signal;
            const url = new URL(request.url);
            let finish: ReturnType<typeof requests.start> | undefined;
            try {
              finish = requests.start(request.method, url.pathname);
            } catch {
              /* Request bookkeeping is optional; the origin guard is not. */
            }
            let status: number | undefined;
            try {
              if (
                url.origin !== registered.origin ||
                url.username ||
                url.password
              )
                throw unavailable("request escaped its origin");
              const combined = AbortSignal.any([signal, request.signal]);
              combined.throwIfAborted();
              let response: Response;
              try {
                response = await transport(
                  new Request(request, { redirect: "error", signal: combined }),
                );
                status = response.status;
              } catch (error) {
                transportFailed = true;
                throw error;
              }
              if (
                (response.status >= 300 && response.status < 400) ||
                response.redirected
              )
                throw unavailable("redirect rejected");
              combined.throwIfAborted();
              finish?.(status, undefined, !response.ok);
              return response;
            } catch (error) {
              finish?.(status, error, true, true);
              throw error;
            }
          },
          { preconnect: transport.preconnect },
        );
        const authentication = headers({
          url: registered.origin,
          ...(registered.password === undefined
            ? {}
            : {
                auth: {
                  type: "basic" as const,
                  username: "opencode",
                  password: registered.password,
                },
              }),
        });
        const client = OpenCode.make({
          baseUrl: registered.origin,
          ...(authentication ? { headers: authentication } : {}),
          fetch: guarded,
        });
        phase = "service";
        const info = await client.server.info({ signal });
        if (info.pid !== process.pid || info.version !== options.version)
          throw unavailable("identity does not match this host");
        const challenge = {
          nonce: randomBytes(32).toString("hex"),
          origin: registered.origin,
        };
        phase = "incarnation";
        const proof = await client.rpc(BackseatRpc).identity(challenge, {
          location: { directory: options.location },
          signal,
        });
        const expected = identity(challenge).mac;
        if (
          !/^[a-f0-9]{64}$/.test(proof.mac) ||
          !timingSafeEqual(
            Buffer.from(proof.mac, "hex"),
            Buffer.from(expected, "hex"),
          )
        )
          throw unavailable("incarnation does not match this host");
        phase = "revalidation";
        if (
          registration(await source(), options.version).fingerprint !==
          registered.fingerprint
        )
          throw unavailable("registration changed");
        phase = "operation";
        const result = await operation(client, signal);
        signal.throwIfAborted();
        phase = "revalidation";
        if (
          registration(await source(), options.version).fingerprint !==
          registered.fingerprint
        )
          throw unavailable("registration changed");
        signal.throwIfAborted();
        diagnostics.emit("debug", "native.completed", { phase: "completion" });
        return result;
      } catch (error) {
        diagnostics.emit("error", "native.failed", {
          phase,
          classification: lifetime.signal.aborted
            ? "disposed"
            : deadline?.aborted
              ? "timeout"
              : callerSignal?.aborted
                ? "cancelled"
                : error instanceof NativeConnectionError
                  ? "validation"
                  : transportFailed
                    ? "transport"
                    : "unknown",
        });
        // Native errors may embed URLs, headers or registration contents.
        if (error instanceof NativeConnectionError) throw error;
        throw lifetime.signal.aborted
          ? unavailable("connection disposed", "disposed")
          : deadline?.aborted
            ? unavailable("read timed out", "timeout")
            : callerSignal?.aborted
              ? unavailable("read cancelled", "cancelled")
              : unavailable(
                  "connection unavailable or unsupported",
                  "unavailable",
                );
      } finally {
        deadline?.removeEventListener("abort", onDeadline);
        requests.close();
      }
    },
    identity,
    dispose() {
      lifetime.abort();
      secret.fill(0);
    },
  };
}
