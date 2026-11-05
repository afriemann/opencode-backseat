import { describe, expect, it, spyOn } from "bun:test";
import { BackseatRpc } from "../src/rpc.ts";
import {
  createNativeConnection,
  readNativeRegistration,
} from "../src/native-connection.ts";
import { constants, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { Effect, Logger } from "effect";
import { hostDiagnostics } from "../src/server.ts";
import * as crypto from "node:crypto";

// spec: openspec/specs/worker-coordination/spec.md
describe("Automatic same-service native connection", () => {
  function fixture(
    diagnostics?: Parameters<typeof createNativeConnection>[0]["diagnostics"],
  ) {
    const calls: Request[] = [];
    let registration: unknown = {
      pid: process.pid,
      version: "2.2.5",
      url: "http://127.0.0.1:49152",
      password: "fixture-password", // pragma: allowlist secret - dummy native registration
    };
    let response: ((request: Request) => Promise<Response>) | undefined;
    const transport: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        if (response) return response(request);
        const url = new URL(request.url);
        if (url.pathname === "/api/info")
          return Response.json({
            pid: process.pid,
            version: "2.2.5",
            urls: [],
            paths: { tmp: "/tmp/opencode" },
          });
        const inputBody = (await request.json()) as {
          input?: { nonce: string; origin: string };
          nonce?: string;
          origin?: string;
        };
        return Response.json({
          output: connection.identity(
            (inputBody.input ?? inputBody) as { nonce: string; origin: string },
          ),
        });
      },
      { preconnect: fetch.preconnect },
    );
    const connection = createNativeConnection({
      location: "/projects/coordinator",
      version: "2.2.5",
      registration: async () => registration,
      fetch: transport,
      ...(diagnostics ? { diagnostics } : {}),
    });
    return {
      connection,
      calls,
      setRegistration(value: unknown) {
        registration = value;
      },
      setResponse(value: typeof response) {
        response = value;
      },
    };
  }

  it("Identifies native request failures without exposing request data", async () => {
    const records: { event: string; fields: Record<string, unknown> }[] = [];
    const f = fixture((_level, event, fields) =>
      records.push({ event, fields: fields! }),
    );
    try {
      await f.connection.read(async (client) => {
        f.setResponse(async () => Response.json({ data: [], cursor: {} }));
        expect(
          await client.session.list({ search: "PRIVATE_REQUEST_SENTINEL" }),
        ).toEqual({ data: [], cursor: {} });
        f.setResponse(
          async () => new Response("PRIVATE_REQUEST_SENTINEL", { status: 503 }),
        );
        await expect(client.session.active()).rejects.toBeDefined();
        for (const code of ["ECONNRESET", "PRIVATE_REQUEST_SENTINEL"]) {
          f.setResponse(async () => {
            throw new Error("PRIVATE_REQUEST_SENTINEL", { cause: { code } });
          });
          await expect(
            client.session.get({ sessionID: "PRIVATE_REQUEST_SENTINEL" }),
          ).rejects.toBeDefined();
        }
        f.setResponse(async () => {
          throw Object.defineProperty(
            new Error("PRIVATE_REQUEST_SENTINEL"),
            "code",
            {
              get() {
                throw new Error("PRIVATE_REQUEST_SENTINEL");
              },
            },
          );
        });
        await expect(client.session.active()).rejects.toBeDefined();
        f.setResponse(
          async () => new Response("PRIVATE_REQUEST_SENTINEL", { status: 503 }),
        );
        for (let i = 0; i < 40; i++)
          await client.session.active().catch(() => undefined);
        return "unchanged result";
      });
      const terminal = records.filter(
        ({ event }) =>
          event === "native.request.completed" ||
          event === "native.request.failed",
      );
      expect(terminal).toHaveLength(32);
      expect(terminal[2]!.fields).toMatchObject({
        requestCategory: "sessions",
        httpStatus: 200,
        requestDurationMs: expect.any(Number),
      });
      expect(terminal[3]!.fields).toMatchObject({
        requestCategory: "activity",
        httpStatus: 503,
      });
      expect(terminal[4]!.fields).toMatchObject({
        requestCategory: "session",
        errorCode: "ECONNRESET",
      });
      expect(terminal[5]!.fields).toMatchObject({ errorCode: "unknown" });
      expect(terminal[6]!.fields).toMatchObject({ errorCode: "unknown" });
      expect(
        records.find(({ event }) => event === "native.request.suppressed")
          ?.fields,
      ).toMatchObject({ requestCategory: "activity", count: 15 });
      expect(JSON.stringify(records)).not.toContain("PRIVATE_REQUEST_SENTINEL");
      expect(
        new Set(terminal.map(({ fields }) => fields.correlation)).size,
      ).toBe(1);
    } finally {
      f.connection.dispose();
    }
  });

  it("Reports active requests at the shared deadline", async () => {
    for (const activeCount of [0, 2]) {
      const records: { event: string; fields: Record<string, unknown> }[] = [];
      const f = fixture((_level, event, fields) =>
        records.push({ event, fields: fields! }),
      );
      const deadline = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
        deadline.signal,
      );
      try {
        await expect(
          f.connection.read(async (client, signal) => {
            if (!activeCount) {
              deadline.abort();
              signal.throwIfAborted();
            }
            let started = 0;
            f.setResponse(
              async (request) =>
                new Promise((_resolve, reject) => {
                  request.signal.addEventListener(
                    "abort",
                    () => reject(request.signal.reason),
                    { once: true },
                  );
                  if (++started === activeCount) deadline.abort();
                }),
            );
            return Promise.all(
              Array.from({ length: activeCount }, () =>
                client.session.active({ signal }),
              ),
            );
          }),
        ).rejects.toThrow(
          "Native service connection unavailable or unsupported",
        );
        expect(
          records.find(({ event }) => event === "native.requests.deadline")
            ?.fields,
        ).toMatchObject({ count: activeCount });
        const snapshots = records.filter(
          ({ event }) => event === "native.request.active",
        );
        expect(snapshots).toHaveLength(activeCount ? 1 : 0);
        if (activeCount)
          expect(snapshots[0]!.fields).toMatchObject({
            requestCategory: "activity",
            count: 2,
            requestDurationMs: expect.any(Number),
          });
      } finally {
        timeout.mockRestore();
        f.connection.dispose();
      }
    }
    const records: string[] = [];
    const f = fixture((_level, event) => records.push(event));
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
      deadline.signal,
    );
    try {
      expect(await f.connection.read(async () => "done")).toBe("done");
      const count = records.length;
      deadline.abort();
      expect(records).toHaveLength(count);
    } finally {
      timeout.mockRestore();
      f.connection.dispose();
    }
  });

  it("Logging failure preserves coordination outcomes", async () => {
    for (const kind of [
      "success",
      "status",
      "rejection",
      "redirect",
      "escape",
      "deadline",
    ] as const) {
      const throwing = fixture(() => {
        throw new Error("Diagnostic sink unavailable");
      });
      const deadline = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
        deadline.signal,
      );
      const NativeRequest = globalThis.Request;
      try {
        const result = throwing.connection.read(async (client, signal) => {
          if (kind === "escape")
            globalThis.Request = class extends NativeRequest {
              override get url() {
                return "http://example.test/api/info";
              }
            };
          throwing.setResponse(async (request) => {
            if (kind === "deadline")
              return new Promise((_resolve, reject) => {
                request.signal.addEventListener(
                  "abort",
                  () => reject(request.signal.reason),
                  { once: true },
                );
                deadline.abort();
              });
            if (kind === "rejection")
              throw new Error("Native transport failure");
            return Response.json(
              { data: [] },
              {
                status:
                  kind === "redirect" ? 302 : kind === "status" ? 503 : 200,
              },
            );
          });
          await client.session.active({ signal });
          return "unchanged result";
        });
        if (kind === "success") expect(await result).toBe("unchanged result");
        else
          await expect(result).rejects.toThrow(
            "Native service connection unavailable or unsupported",
          );
        const count = throwing.calls.length;
        deadline.abort();
        expect(throwing.calls).toHaveLength(count);
      } finally {
        globalThis.Request = NativeRequest;
        timeout.mockRestore();
        throwing.connection.dispose();
      }
    }
    let attempts = 0;
    const diagnostics = Effect.runSync(
      hostDiagnostics.pipe(
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make(() => {
              attempts++;
              throw new Error("Diagnostic sink unavailable");
            }),
          ]),
        ),
      ),
    );
    const f = fixture(diagnostics);
    try {
      const token = spyOn(crypto, "randomUUID").mockImplementationOnce(() => {
        throw new Error("Entropy unavailable");
      });
      try {
        expect(await f.connection.read(async () => "unchanged result")).toBe(
          "unchanged result",
        );
        expect(token).toHaveBeenCalled();
      } finally {
        token.mockRestore();
      }
      await expect(
        f.connection.read(async () => {
          throw new Error("Sensitive native failure");
        }),
      ).rejects.toThrow("Native service connection unavailable or unsupported");
      f.connection.dispose();
      await expect(
        f.connection.read(async () => "unreachable"),
      ).rejects.toThrow("Native service connection disposed");
      expect(attempts).toBeGreaterThan(0);
    } finally {
      f.connection.dispose();
    }
  });

  it("Excludes sensitive diagnostic data", async () => {
    const records: Record<string, unknown>[] = [];
    const hostile = fixture((_level, event, fields) => {
      if (event === "native.request.failed") records.push(fields!);
    });
    try {
      expect(
        await hostile.connection.read(async (client) => {
          hostile.setResponse(async () => {
            throw new Proxy(
              {},
              {
                getOwnPropertyDescriptor() {
                  throw new Error("PRIVATE_NATIVE_SENTINEL");
                },
              },
            );
          });
          await client.session.active().catch(() => undefined);
          hostile.setResponse(async () => new Response(null, { status: 503 }));
          await client.session
            .create({ title: "PRIVATE_NATIVE_SENTINEL" })
            .catch(() => undefined);
          return "unchanged result";
        }),
      ).toBe("unchanged result");
      expect(records[0]).toMatchObject({
        requestCategory: "activity",
        errorCode: "unknown",
      });
      expect(records[1]).toMatchObject({
        requestCategory: "unknown",
        httpStatus: 503,
      });
      expect(JSON.stringify(records)).not.toContain("PRIVATE_NATIVE_SENTINEL");
    } finally {
      hostile.connection.dispose();
    }
    for (const kind of [
      "disposed",
      "timeout",
      "cancelled",
      "transport",
      "validation",
      "unknown",
    ] as const) {
      const failures: Record<string, unknown>[] = [];
      const f = fixture((_level, event, fields) => {
        if (event === "native.failed") failures.push(fields!);
      });
      const deadline = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
        deadline.signal,
      );
      const caller = new AbortController();
      if (kind === "disposed") f.connection.dispose();
      if (kind === "validation") f.setRegistration(undefined);
      if (kind === "transport")
        f.setResponse(async () => {
          throw new Error("PRIVATE_NATIVE_SENTINEL");
        });
      try {
        await expect(
          f.connection.read(async (client) => {
            if (kind === "timeout") deadline.abort();
            if (kind === "cancelled") {
              f.setResponse(async () => {
                caller.abort();
                throw caller.signal.reason;
              });
              return client.server.info({ signal: caller.signal });
            }
            throw new Error("PRIVATE_NATIVE_SENTINEL");
          }),
        ).rejects.toThrow(
          kind === "disposed"
            ? "Native service connection disposed"
            : kind === "validation"
              ? "Native service registration unavailable"
              : "Native service connection unavailable or unsupported",
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
          classification: kind,
          phase:
            kind === "disposed" || kind === "validation"
              ? "registration"
              : kind === "transport"
                ? "service"
                : "operation",
        });
        expect(JSON.stringify(failures)).not.toContain(
          "PRIVATE_NATIVE_SENTINEL",
        );
      } finally {
        timeout.mockRestore();
        f.connection.dispose();
      }
    }
  });

  it("Connects automatically to the current native service", async () => {
    const f = fixture();
    try {
      const result = await f.connection.read(async (_client, signal) => ({
        connected: !signal.aborted,
      }));
      expect(result).toEqual({ connected: true });
      expect(f.calls.length).toBeGreaterThanOrEqual(2);
      expect(
        f.calls.every(
          (r) =>
            r.headers.get("authorization") ===
            `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`,
        ),
      ).toBe(true);
      expect(f.calls.every((r) => r.redirect === "error")).toBe(true);
    } finally {
      f.connection.dispose();
    }
  });

  it("Rejects an unavailable or different native service", async () => {
    for (const kind of [
      "missing",
      "pid",
      "version",
      "incarnation",
      "server-pid",
      "server-version",
      "registration",
      "replacement",
    ] as const) {
      const f = fixture();
      if (kind === "missing") f.setRegistration(undefined);
      if (kind === "pid")
        f.setRegistration({
          pid: process.pid + 1,
          version: "2.2.5",
          url: "http://127.0.0.1:49152",
        });
      if (kind === "version")
        f.setRegistration({
          pid: process.pid,
          version: "2.0.26",
          url: "http://127.0.0.1:49152",
        });
      if (kind === "incarnation")
        f.setResponse(async (request) =>
          new URL(request.url).pathname === "/api/info"
            ? Response.json({ pid: process.pid, version: "2.2.5" })
            : Response.json({ output: { mac: "0".repeat(64) } }),
        );
      if (kind === "server-pid" || kind === "server-version")
        f.setResponse(async () =>
          Response.json({
            pid: kind === "server-pid" ? process.pid + 1 : process.pid,
            version: kind === "server-version" ? "2.0.26" : "2.2.5",
          }),
        );
      if (kind === "registration" || kind === "replacement")
        f.setResponse(async (request) => {
          if (new URL(request.url).pathname === "/api/info")
            return Response.json({ pid: process.pid, version: "2.2.5" });
          const body = (await request.json()) as {
            input: { nonce: string; origin: string };
          };
          const output = f.connection.identity(body.input);
          f.setRegistration(
            kind === "registration"
              ? undefined
              : {
                  pid: process.pid,
                  version: "2.2.5",
                  url: "http://127.0.0.1:49153",
                },
          );
          return Response.json({ output });
        });
      let accepted = false;
      try {
        await expect(
          f.connection.read(async () => {
            accepted = true;
          }),
        ).rejects.toThrow("Native service");
      } finally {
        f.connection.dispose();
      }
      expect(accepted).toBe(false);
    }
    expect(
      BackseatRpc.methods.identity.input["~standard"].validate({
        nonce: "bad",
        origin: "http://127.0.0.1",
      }),
    ).toHaveProperty("issues");
    expect(
      BackseatRpc.methods.identity.output["~standard"].validate({ mac: "bad" }),
    ).toHaveProperty("issues");
    const changed = fixture();
    try {
      await expect(
        changed.connection.read(async () => {
          changed.setRegistration(undefined);
          return "stale inventory";
        }),
      ).rejects.toThrow("Native service");
    } finally {
      changed.connection.dispose();
    }
  });

  it("Explains initial registration-directory rejection", async () => {
    const uid = process.getuid!();
    for (const [mode, owner, path, reason, detail] of [
      [constants.S_IFREG | 0o644, uid, "/safe/leaf", "not a directory", "0644"],
      [
        constants.S_IFLNK | 0o777,
        uid,
        "/safe/leaf",
        "symbolic link",
        "not a directory",
      ],
      [
        constants.S_IFDIR | 0o755,
        uid + 1,
        "/safe/leaf",
        `UID ${uid + 1}`,
        `UID 0 or ${uid}`,
      ],
      [constants.S_IFDIR | 0o777, uid, "/safe/leaf", "other-writable", "0777"],
      [constants.S_IFDIR | 0o777, uid, "/safe", "other-writable", "0777"],
    ] as const) {
      let opened = false;
      const inspected: string[] = [];
      const files = {
        async lstat(candidate: string) {
          inspected.push(candidate);
          return Object.assign(Object.create(Stats.prototype) as Stats, {
            mode: candidate === path ? mode : constants.S_IFDIR | 0o755,
            uid: candidate === path ? owner : uid,
            dev: 1,
            ino: 1,
          });
        },
        async open() {
          opened = true;
          throw new Error("Registration contents must not be opened");
        },
      } as unknown as NonNullable<Parameters<typeof readNativeRegistration>[1]>;
      const connection = createNativeConnection({
        location: "/projects/coordinator",
        version: "2.2.5",
        registration: () =>
          readNativeRegistration("/safe/leaf/service.json", files),
      });
      try {
        const error = await connection
          .read(async () => "unexpected inventory")
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain(JSON.stringify(path));
        expect(message).toContain(reason);
        expect(message).toContain(detail);
        expect(message).toContain("Review");
        expect(opened).toBe(false);
        expect(inspected).not.toContain("/safe/leaf/service.json");
      } finally {
        connection.dispose();
      }
    }
  });

  it("Supports trusted writable registration ancestry", async () => {
    for (const mode of [0o775, 0o2775, 0o1777]) {
      const contents = Buffer.from(JSON.stringify({ pid: process.pid }));
      const file = Object.assign(Object.create(Stats.prototype) as Stats, {
        mode: constants.S_IFREG | 0o600,
        uid: process.getuid!(),
        nlink: 1,
        size: contents.length,
        dev: 1,
        ino: 2,
        mtimeMs: 1,
        ctimeMs: 1,
      });
      const directory = Object.assign(Object.create(Stats.prototype) as Stats, {
        mode: constants.S_IFDIR | mode,
        uid: process.getuid!(),
        dev: 1,
        ino: 1,
      });
      const files = {
        async lstat(path: string) {
          if (path.endsWith("service.json")) return file;
          return directory;
        },
        async open() {
          return {
            async stat() {
              return file;
            },
            async read(buffer: Buffer, offset: number) {
              return {
                bytesRead: offset === 0 ? contents.copy(buffer) : 0,
                buffer,
              };
            },
            async close() {},
          };
        },
      } as unknown as NonNullable<Parameters<typeof readNativeRegistration>[1]>;
      expect(
        await readNativeRegistration("/safe/leaf/service.json", files),
      ).toEqual({ pid: process.pid });
    }
  });

  it("Rejects unsafe destinations before exposing credentials", async () => {
    for (const unsafe of [
      "none",
      "file-mode",
      "owner",
      "link",
      "symlink",
      "changed",
      "post-file",
      "post-name",
      "post-ancestor",
      "post-mode",
      "sticky-owner",
      "oversized",
    ] as const) {
      const contents = Buffer.from(
        JSON.stringify({
          pid: process.pid,
          version: "2.2.5",
          url: "http://127.0.0.1:49152",
        }),
      );
      const stat = Object.assign(Object.create(Stats.prototype) as Stats, {
        mode: constants.S_IFREG | 0o600,
        uid: process.getuid!(),
        nlink: 1,
        size: contents.length,
        dev: 1,
        ino: 2,
        mtimeMs: 1,
        ctimeMs: 1,
      });
      const directory = Object.assign(Object.create(Stats.prototype) as Stats, {
        mode: constants.S_IFDIR | 0o755,
        uid: 0,
        dev: 1,
        ino: 1,
      });
      if (unsafe === "file-mode") stat.mode |= 0o040;
      if (unsafe === "owner") stat.uid += 1;
      if (unsafe === "link") stat.nlink = 2;
      if (unsafe === "symlink") stat.mode = constants.S_IFLNK | 0o600;
      if (unsafe === "oversized") stat.size = 20_000;
      if (unsafe === "sticky-owner") {
        directory.mode = constants.S_IFDIR | 0o1777;
      }
      let opened = false,
        closed = false,
        reads = 0;
      const files = {
        async lstat(path: string) {
          if (unsafe === "sticky-owner" && path === "/safe")
            return Object.assign(
              Object.create(Stats.prototype) as Stats,
              directory,
              { uid: process.getuid!() + 1 },
            );
          if (
            unsafe === "post-mode" &&
            reads > 0 &&
            !path.endsWith("service.json")
          )
            return Object.assign(
              Object.create(Stats.prototype) as Stats,
              directory,
              { mode: constants.S_IFDIR | 0o777 },
            );
          if (
            unsafe === "post-name" &&
            reads > 0 &&
            path.endsWith("service.json")
          )
            return Object.assign(
              Object.create(Stats.prototype) as Stats,
              stat,
              { ino: 99 },
            );
          if (
            unsafe === "post-ancestor" &&
            reads > 0 &&
            !path.endsWith("service.json")
          )
            return Object.assign(
              Object.create(Stats.prototype) as Stats,
              directory,
              { ino: 99 },
            );
          return path.endsWith("service.json") ? stat : directory;
        },
        async open(_path: string, flags: number) {
          opened = true;
          expect(flags & constants.O_NOFOLLOW).not.toBe(0);
          return {
            async stat() {
              return unsafe === "changed" ||
                (unsafe === "post-file" && reads > 0)
                ? Object.assign(Object.create(Stats.prototype) as Stats, stat, {
                    ino: 3,
                  })
                : stat;
            },
            async read(buffer: Buffer, offset: number) {
              reads++;
              return {
                bytesRead: offset === 0 ? contents.copy(buffer) : 0,
                buffer,
              };
            },
            async close() {
              closed = true;
            },
          } as unknown as FileHandle;
        },
      } as unknown as NonNullable<Parameters<typeof readNativeRegistration>[1]>;
      if (unsafe === "none") {
        expect(
          await readNativeRegistration("/safe/service.json", files),
        ).toMatchObject({ pid: process.pid });
        expect(reads).toBeGreaterThan(0);
      } else {
        await expect(
          readNativeRegistration("/safe/service.json", files),
        ).rejects.toThrow("Native service");
        if (
          unsafe === "post-file" ||
          unsafe === "post-name" ||
          unsafe === "post-ancestor" ||
          unsafe === "post-mode"
        )
          expect(reads).toBeGreaterThan(0);
        else expect(reads).toBe(0);
      }
      expect(closed).toBe(opened);
    }
    for (const url of [
      "http://example.test",
      "http://localhost:49152",
      "http://127.0.0.1:49152/path",
      "http://user:password@127.0.0.1:49152", // pragma: allowlist secret - rejected dummy URL
      "https://127.0.0.1:49152",
      "http://127.0.0.1:49152/?secret=fixture",
    ]) {
      const f = fixture();
      f.setRegistration({
        pid: process.pid,
        version: "2.2.5",
        url,
        password: "fixture-password", // pragma: allowlist secret - dummy native registration
      });
      try {
        await expect(f.connection.read(async () => true)).rejects.toThrow(
          "Native service",
        );
        expect(f.calls).toEqual([]);
      } finally {
        f.connection.dispose();
      }
    }
    const f = fixture();
    f.setResponse(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://example.test" },
        }),
    );
    try {
      await expect(f.connection.read(async () => true)).rejects.toThrow(
        "Native service",
      );
      expect(f.calls).toHaveLength(1);
    } finally {
      f.connection.dispose();
    }
    const escaped = fixture();
    const NativeRequest = globalThis.Request;
    globalThis.Request = class extends NativeRequest {
      override get url() {
        return "http://example.test/api/info";
      }
    };
    try {
      await expect(escaped.connection.read(async () => true)).rejects.toThrow(
        "Native service",
      );
      expect(escaped.calls).toHaveLength(0);
    } finally {
      globalThis.Request = NativeRequest;
      escaped.connection.dispose();
    }
  });

  it("Cancels native reads when the plugin unloads", async () => {
    const f = fixture();
    let reached = false;
    const pending = f.connection.read(async (_client, signal) => {
      reached = true;
      f.connection.dispose();
      expect(signal.aborted).toBe(true);
      return "stale inventory";
    });
    await expect(pending).rejects.toThrow("Native service");
    await expect(
      f.connection.read(async () => "stale inventory"),
    ).rejects.toThrow("Native service");
    expect(reached).toBe(true);
    for (const mode of ["dispose", "timeout"] as const) {
      const active = fixture();
      const deadline = new AbortController();
      const clock =
        mode === "timeout"
          ? spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
          : undefined;
      let interrupted = false;
      active.setResponse(
        async (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                interrupted = true;
                reject(request.signal.reason);
              },
              { once: true },
            );
            queueMicrotask(() =>
              mode === "dispose"
                ? active.connection.dispose()
                : deadline.abort(new Error("Request timeout")),
            );
          }),
      );
      try {
        await expect(
          active.connection.read(async () => "stale inventory"),
        ).rejects.toThrow("Native service");
        expect(interrupted).toBe(true);
      } finally {
        clock?.mockRestore();
        active.connection.dispose();
      }
    }
  });
});
