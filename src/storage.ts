import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const maximumEnvelopeBytes = 32 * 1024 * 1024;
const localFilesystems = new Set([
  0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630,
]);
const unsafeStorage = () =>
  new Error("Shared storage is unsafe or incomplete; coordination held");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export function encodeBounded(
  value: unknown,
  maximumBytes = maximumEnvelopeBytes,
): Buffer {
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  let bytes = 0,
    nodes = 0;
  const append = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > maximumBytes) throw unsafeStorage();
    chunks.push(text);
  };
  const string = (text: string) => {
    let size = 2;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x20) size += 6;
      else if (code === 34 || code === 92) size += 2;
      else if (code < 0x80) size++;
      else if (code < 0x800) size += 2;
      else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      ) {
        size += 4;
        i++;
      } else size += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
      if (bytes + size > maximumBytes) throw unsafeStorage();
    }
    append(JSON.stringify(text));
  };
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 100_000 || depth > 64) throw unsafeStorage();
    if (item === null) {
      append("null");
      return;
    }
    if (typeof item === "string") {
      string(item);
      return;
    }
    if (
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      append(JSON.stringify(item));
      return;
    }
    if (typeof item !== "object" || ancestors.has(item)) throw unsafeStorage();
    if (
      !Array.isArray(item) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      throw unsafeStorage();
    ancestors.add(item);
    const array = Array.isArray(item);
    append(array ? "[" : "{");
    let first = true;
    const entry = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) throw unsafeStorage();
      if (!first) append(",");
      first = false;
      if (!array) {
        string(key);
        append(":");
      }
      visit(descriptor.value, depth + 1);
    };
    if (array) {
      if (item.length > 100_000) throw unsafeStorage();
      for (let i = 0; i < item.length; i++) entry(String(i));
    } else for (const key in item) if (Object.hasOwn(item, key)) entry(key);
    append(array ? "]" : "}");
    ancestors.delete(item);
  };
  visit(value, 0);
  return Buffer.from(chunks.join(""));
}

export interface SharedStorage {
  readonly directory: string;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  close(): Promise<void>;
}

export function resolveDataDirectory(
  options: { dataDir?: string } = {},
  environment: { XDG_DATA_HOME?: string; home: string } = {
    ...process.env,
    home: homedir(),
  },
): string {
  if (options.dataDir !== undefined) {
    if (!isAbsolute(options.dataDir))
      throw new Error("dataDir must be an absolute path");
    return resolve(options.dataDir);
  }
  const base =
    environment.XDG_DATA_HOME && isAbsolute(environment.XDG_DATA_HOME)
      ? environment.XDG_DATA_HOME
      : join(environment.home, ".local", "share");
  return join(base, "opencode-conman");
}

export interface AnchoredDirectory {
  readonly directory: string;
  readonly path: string;
  validate(): Promise<void>;
  validateFile(file: FileHandle, name: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export async function openAnchoredDirectory(
  directory: string,
  create = true,
): Promise<AnchoredDirectory> {
  if (
    process.platform !== "linux" ||
    !process.getuid ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    !constants.O_NOFOLLOW ||
    !constants.O_DIRECTORY
  )
    throw unsafeStorage();
  const uid = process.getuid();
  const entries: { file: FileHandle; path: string }[] = [];
  const close = async () => {
    const results = await Promise.allSettled(
      entries
        .slice()
        .reverse()
        .map((entry) => entry.file.close()),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  const check = async (
    file: FileHandle,
    path: string,
    privateDirectory: boolean,
    directoryEntry: boolean,
  ) => {
    const actual = await file.stat();
    const named = await lstat(path);
    if (
      actual.ino !== named.ino ||
      actual.dev !== named.dev ||
      named.isSymbolicLink() ||
      (directoryEntry
        ? !actual.isDirectory()
        : !actual.isFile() || actual.nlink !== 1) ||
      (actual.uid !== uid && actual.uid !== 0) ||
      (actual.mode & 0o022) !== 0 ||
      ((privateDirectory || !directoryEntry) &&
        (actual.uid !== uid ||
          (actual.mode & 0o777) !== (directoryEntry ? 0o700 : 0o600)))
    )
      throw unsafeStorage();
  };
  const validate = async () => {
    for (const entry of entries)
      await check(entry.file, entry.path, entry.path === directory, true);
  };
  try {
    let parent = await open(
      "/",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    entries.push({ file: parent, path: "/" });
    let path = "";
    for (const part of directory.slice(1).split("/").filter(Boolean)) {
      const anchored = `/proc/self/fd/${parent.fd}/${part}`;
      if (create) {
        try {
          await mkdir(anchored, { mode: 0o700 });
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          ))
            throw error;
        }
        await parent.sync();
      }
      parent = await open(
        anchored,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      path += `/${part}`;
      entries.push({ file: parent, path });
      await validate();
    }
    if (
      !localFilesystems.has((await statfs(`/proc/self/fd/${parent.fd}`)).type)
    )
      throw unsafeStorage();
    return {
      directory,
      path: `/proc/self/fd/${parent.fd}`,
      validate,
      async validateFile(file, name) {
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw unsafeStorage();
        await validate();
        await check(file, `${directory}/${name}`, false, false);
      },
      sync: () => parent.sync(),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

type Envelope = { version: 1; values: Record<string, unknown> };

export async function openSharedStorage(
  directory: string,
  { readOnly = false }: { readOnly?: boolean } = {},
): Promise<SharedStorage> {
  const anchor = await openAnchoredDirectory(directory, !readOnly);
  let closed = false,
    held = false;
  let uninitialized = false;
  let tail = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(unsafeStorage());
    const next = tail.then(async () => {
      if (held) throw unsafeStorage();
      try {
        return await work();
      } catch (error) {
        held = true;
        throw error;
      }
    });
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const read = async (name: string): Promise<string> => {
    await anchor.validate();
    const file = await open(
      `${anchor.path}/${name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      await anchor.validateFile(file, name);
      const before = await file.stat();
      if (before.size > maximumEnvelopeBytes) throw unsafeStorage();
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!bytesRead) throw unsafeStorage();
        offset += bytesRead;
      }
      await anchor.validateFile(file, name);
      const after = await file.stat();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw unsafeStorage();
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
      await file.close();
    }
  };
  const checkEntries = async (initialized: boolean) => {
    const entries = await opendir(anchor.path);
    for await (const entry of entries)
      if (
        !(
          initialized
            ? ["initialized", "state.json", "ownership.lock"]
            : ["ownership.lock"]
        ).includes(entry.name)
      )
        throw unsafeStorage();
  };
  const load = async (): Promise<Envelope> => {
    if (readOnly && uninitialized) {
      await checkEntries(false);
      return { version: 1, values: {} };
    }
    await checkEntries(true);
    if ((await read("initialized")) !== "1\n") throw unsafeStorage();
    const value: unknown = JSON.parse(await read("state.json"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw unsafeStorage();
    const envelope = value as Envelope;
    if (
      envelope.version !== 1 ||
      !envelope.values ||
      typeof envelope.values !== "object" ||
      Array.isArray(envelope.values) ||
      Object.keys(envelope).sort().join() !== "values,version"
    )
      throw unsafeStorage();
    return envelope;
  };
  const publish = async (value: Envelope, initialize = false) => {
    const bytes = encodeBounded(value);
    await anchor.validate();
    const temporary = `.publish-${randomUUID()}`;
    const file = await open(
      `${anchor.path}/${temporary}`,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await anchor.validateFile(file, temporary);
      await file.writeFile(bytes);
      await file.sync();
      await anchor.validateFile(file, temporary);
      if (!initialize) await read("state.json");
      await rename(`${anchor.path}/${temporary}`, `${anchor.path}/state.json`);
      await anchor.sync();
      await anchor.validate();
      await read("state.json");
    } finally {
      await file.close();
    }
  };
  try {
    let initialized = true;
    try {
      await lstat(`${anchor.path}/initialized`);
    } catch (error) {
      if (!missing(error)) throw error;
      initialized = false;
    }
    if (!initialized) {
      await checkEntries(false);
      if (readOnly) uninitialized = true;
      else {
        const marker = await open(
          `${anchor.path}/initialized`,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await anchor.validateFile(marker, "initialized");
          await marker.writeFile("1\n");
          await marker.sync();
          await anchor.sync();
        } finally {
          await marker.close();
        }
        await publish({ version: 1, values: {} }, true);
      }
    }
    await load();
  } catch (error) {
    await anchor.close();
    throw error;
  }
  return {
    directory,
    get(key) {
      return serial(async () => {
        const envelope = await load();
        return Object.hasOwn(envelope.values, key)
          ? structuredClone(envelope.values[key])
          : undefined;
      });
    },
    set(key, value) {
      return serial(async () => {
        if (readOnly) throw new Error("Recovery inventory is read-only");
        const envelope = await load();
        Object.defineProperty(envelope.values, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        await publish(envelope);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await tail;
      await anchor.close();
    },
  };
}
