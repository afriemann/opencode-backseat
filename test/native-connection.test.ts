import { describe, expect, it, spyOn } from "bun:test";
import { BackseatRpc } from "../src/rpc.ts";
import {
  createNativeConnection,
  readNativeRegistration,
} from "../src/native-connection.ts";
import { constants, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

// spec: openspec/specs/worker-coordination/spec.md
describe("Automatic same-service native connection", () => {
  function fixture() {
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

  it("Rejects unsafe destinations before exposing credentials", async () => {
    for (const unsafe of [
      "none",
      "file-mode",
      "owner",
      "link",
      "symlink",
      "ancestor",
      "changed",
      "post-file",
      "post-name",
      "post-ancestor",
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
      if (unsafe === "ancestor") directory.mode |= 0o002;
      if (unsafe === "oversized") stat.size = 20_000;
      let opened = false,
        closed = false,
        reads = 0;
      const files = {
        async lstat(path: string) {
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
          unsafe === "post-ancestor"
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
