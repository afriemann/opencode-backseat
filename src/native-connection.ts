import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { fallback, headers } from "@opencode/client/service";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { BackseatRpc } from "./rpc.ts";

const REGISTRATION_BYTES = 16_384;
const REQUEST_TIMEOUT = 10_000;
const hasUnsafeOtherWrite = (mode: number): boolean =>
  (mode & 0o002) !== 0 && (mode & 0o1000) === 0;
class NativeConnectionError extends Error {}
const unavailable = (reason: string): Error =>
  new NativeConnectionError(`Native service ${reason}`);

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
  ): Promise<T>;
  identity(input: { nonce: string; origin: string }): { mac: string };
  dispose(): void;
}

export function createNativeConnection(options: {
  location: string;
  version: string;
  registration?: () => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
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
    async read(operation) {
      try {
        lifetime.signal.throwIfAborted();
        const registered = registration(await source(), options.version);
        const signal = AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT),
        ]);
        const guarded: typeof fetch = Object.assign(
          async (input: string | URL | Request, init?: RequestInit) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (
              url.origin !== registered.origin ||
              url.username ||
              url.password
            )
              throw unavailable("request escaped its origin");
            const combined = AbortSignal.any([signal, request.signal]);
            combined.throwIfAborted();
            const response = await transport(
              new Request(request, { redirect: "error", signal: combined }),
            );
            if (
              (response.status >= 300 && response.status < 400) ||
              response.redirected
            )
              throw unavailable("redirect rejected");
            combined.throwIfAborted();
            return response;
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
        const info = await client.server.info({ signal });
        if (info.pid !== process.pid || info.version !== options.version)
          throw unavailable("identity does not match this host");
        const challenge = {
          nonce: randomBytes(32).toString("hex"),
          origin: registered.origin,
        };
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
        if (
          registration(await source(), options.version).fingerprint !==
          registered.fingerprint
        )
          throw unavailable("registration changed");
        const result = await operation(client, signal);
        signal.throwIfAborted();
        if (
          registration(await source(), options.version).fingerprint !==
          registered.fingerprint
        )
          throw unavailable("registration changed");
        signal.throwIfAborted();
        return result;
      } catch (error) {
        // Native errors may embed URLs, headers or registration contents.
        if (error instanceof NativeConnectionError) throw error;
        throw unavailable(
          lifetime.signal.aborted
            ? "connection disposed"
            : "connection unavailable or unsupported",
        );
      }
    },
    identity,
    dispose() {
      lifetime.abort();
      secret.fill(0);
    },
  };
}
