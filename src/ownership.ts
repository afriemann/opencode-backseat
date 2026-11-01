import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import { resolve } from "node:path";

function serialQueue() {
  let tail = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export interface LockInspection {
  safe: boolean;
  lock?: { owner: string; running: boolean };
}

export interface OwnershipPort {
  inspect(home: string): Promise<LockInspection>;
  acquire(home: string, owner: string): Promise<boolean>;
  release(home: string, owner: string): Promise<void>;
  approveRecovery(home: string, owner: string): Promise<void>;
  recover(home: string, owner: string): Promise<void>;
}

interface ProcessIdentity {
  boot: string;
  namespace: string;
  pid: number;
  start: string;
}
interface FilesystemOwner {
  version: 1;
  owner: string;
  released: boolean;
  identity: ProcessIdentity;
}
interface KernelGuard {
  file: FileHandle;
  validate(): Promise<void>;
  close(): Promise<void>;
}

const ownerRecordLimit = 8192;
// Linux magic.h: ext, XFS, Btrfs, tmpfs, overlayfs; unknown/network types hold.
const localFilesystems = new Set([
  0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630,
]);
const ownershipError = () => new Error("Recovery is not eligible");

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function processStart(pid: number): Promise<string> {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const start = text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
  if (!start || !/^\d+$/.test(start)) throw ownershipError();
  return start;
}

async function processIdentity(): Promise<ProcessIdentity> {
  const self = await readFile("/proc/self/stat", "utf8");
  if (!self.startsWith(`${process.pid} (`)) throw ownershipError();
  const boot = (
    await readFile("/proc/sys/kernel/random/boot_id", "utf8")
  ).trim();
  if (!/^[a-f0-9-]{36}$/.test(boot)) throw ownershipError();
  const namespace = (
    await stat("/proc/self/ns/pid", { bigint: true })
  ).ino.toString();
  return {
    boot,
    namespace,
    pid: process.pid,
    start: await processStart(process.pid),
  };
}

async function terminated(identity: ProcessIdentity): Promise<boolean> {
  const current = await processIdentity();
  // A different host/boot/PID namespace is uncertainty, not termination proof.
  if (
    identity.boot !== current.boot ||
    identity.namespace !== current.namespace
  )
    return false;
  try {
    return (await processStart(identity.pid)) !== identity.start;
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
}

function parseOwner(text: string): FilesystemOwner | undefined {
  if (!text) return undefined;
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object") throw ownershipError();
  const record = value as FilesystemOwner;
  const identity = record.identity;
  if (
    record.version !== 1 ||
    typeof record.owner !== "string" ||
    !record.owner ||
    record.owner.length > 512 ||
    typeof record.released !== "boolean" ||
    !identity ||
    typeof identity.boot !== "string" ||
    !/^[a-f0-9-]{36}$/.test(identity.boot) ||
    typeof identity.namespace !== "string" ||
    !/^\d+$/.test(identity.namespace) ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid < 1 ||
    typeof identity.start !== "string" ||
    !/^\d+$/.test(identity.start)
  )
    throw ownershipError();
  return record;
}

async function readOwner(
  guard: KernelGuard,
): Promise<{ text: string; record: FilesystemOwner | undefined }> {
  await guard.validate();
  const { size } = await guard.file.stat();
  if (size > ownerRecordLimit) throw ownershipError();
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await guard.file.read(
      bytes,
      offset,
      size - offset,
      offset,
    );
    if (!bytesRead) throw ownershipError();
    offset += bytesRead;
  }
  if ((await guard.file.stat()).size !== size) throw ownershipError();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { text, record: parseOwner(text) };
}

async function writeOwner(
  guard: KernelGuard,
  record: FilesystemOwner,
): Promise<void> {
  await guard.validate();
  const bytes = Buffer.from(JSON.stringify(record));
  let written = 0;
  while (written < bytes.length) {
    const result = await guard.file.write(
      bytes,
      written,
      bytes.length - written,
      written,
    );
    if (!result.bytesWritten) throw ownershipError();
    written += result.bytesWritten;
  }
  await guard.file.truncate(bytes.length);
  await guard.file.sync();
  await guard.validate();
}

async function acquireKernelLock(file: FileHandle): Promise<boolean> {
  const helperInfo = await lstat("/usr/bin/flock");
  for (const directory of ["/usr", "/usr/bin"]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw ownershipError();
  }
  if (
    !helperInfo.isFile() ||
    helperInfo.uid !== 0 ||
    (helperInfo.mode & 0o022) !== 0 ||
    (helperInfo.mode & 0o111) === 0
  )
    throw ownershipError();
  const exit = await new Promise<number | null>((done, reject) => {
    let failure: Error | undefined;
    const helper = spawn("/usr/bin/flock", ["-n", "-x", "0"], {
      stdio: [file.fd, "ignore", "ignore"],
      env: {},
    });
    helper.once("error", (error) => {
      failure = error;
    });
    helper.once("close", (code) => {
      if (failure) reject(failure);
      else done(code);
    });
  });
  if (exit !== 0 && exit !== 1) throw ownershipError();
  return exit === 0;
}

async function kernelGuard(home: string): Promise<KernelGuard | undefined> {
  if (
    process.platform !== "linux" ||
    typeof Bun === "undefined" ||
    Bun.version !== "1.4.4" ||
    !process.getuid ||
    !constants.O_NOFOLLOW ||
    !constants.O_DIRECTORY ||
    resolve(home) !== home ||
    (await realpath(home)) !== home
  )
    throw ownershipError();
  const uid = process.getuid();
  const handles: {
    file: FileHandle;
    path: string;
    directory: boolean;
    private: boolean;
  }[] = [];
  const close = async () => {
    const results = await Promise.allSettled(
      handles
        .slice()
        .reverse()
        .map(({ file }) => file.close()),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  const validate = async () => {
    for (const entry of handles) {
      const actual = await entry.file.stat();
      const named = await lstat(entry.path);
      if (
        actual.ino !== named.ino ||
        actual.dev !== named.dev ||
        named.isSymbolicLink() ||
        (entry.directory
          ? !actual.isDirectory()
          : !actual.isFile() || actual.nlink !== 1) ||
        (actual.uid !== uid && actual.uid !== 0) ||
        (actual.mode & 0o022) !== 0 ||
        (entry.private &&
          (actual.uid !== uid ||
            (actual.mode & 0o777) !== (entry.directory ? 0o700 : 0o600)))
      )
        throw ownershipError();
    }
  };
  try {
    const root = await open(
      "/",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push({ file: root, path: "/", directory: true, private: false });
    let parent = root;
    let path = "";
    for (const part of [
      ...home.slice(1).split("/").filter(Boolean),
      ".opencode",
      "conman",
    ]) {
      path += `/${part}`;
      const privateDirectory = path === `${home}/.opencode/conman`;
      const anchored = `/proc/self/fd/${parent.fd}/${part}`;
      if (path === `${home}/.opencode` || privateDirectory) {
        try {
          await mkdir(anchored, { mode: 0o700 });
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
      }
      const file = await open(
        anchored,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push({ file, path, directory: true, private: privateDirectory });
      parent = file;
      await validate();
    }
    const filesystem = await statfs(`/proc/self/fd/${parent.fd}`);
    if (!localFilesystems.has(filesystem.type)) throw ownershipError();
    const file = await open(
      `/proc/self/fd/${parent.fd}/ownership.lock`,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    handles.push({
      file,
      path: `${path}/ownership.lock`,
      directory: false,
      private: true,
    });
    await validate();
    if (!(await acquireKernelLock(file))) {
      await close();
      return undefined;
    }
    await validate();
    return { file, validate, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function createFilesystemOwnershipPort(
  approveRecovery: (home: string, owner: string) => Promise<void>,
): OwnershipPort {
  const serial = serialQueue();
  const owned = new Map<
    string,
    { guard: KernelGuard; record: FilesystemOwner }
  >();
  const approvals = new Map<string, string>();
  async function withGuard<T>(
    home: string,
    work: (guard: KernelGuard) => Promise<T>,
  ): Promise<T> {
    const lease = owned.get(home);
    const guard = lease?.guard ?? (await kernelGuard(home));
    if (!guard) throw ownershipError();
    try {
      return await work(guard);
    } finally {
      if (!lease) await guard.close();
    }
  }
  return {
    inspect(home) {
      return serial(async () => {
        try {
          return await withGuard(
            home,
            async (guard): Promise<LockInspection> => {
              const { record } = await readOwner(guard);
              return record && !record.released
                ? {
                    safe: true,
                    lock: {
                      owner: record.owner,
                      running: !(await terminated(record.identity)),
                    },
                  }
                : { safe: true };
            },
          );
        } catch {
          return { safe: false };
        }
      });
    },
    acquire(home, owner) {
      return serial(async () => {
        if (!owner || owner.length > 512 || owned.has(home)) return false;
        let guard: KernelGuard | undefined;
        try {
          guard = await kernelGuard(home);
          if (!guard) return false;
          const { record: prior } = await readOwner(guard);
          if (prior && !prior.released) return false;
          const record: FilesystemOwner = {
            version: 1,
            owner,
            released: false,
            identity: await processIdentity(),
          };
          await writeOwner(guard, record);
          owned.set(home, { guard, record });
          guard = undefined;
          return true;
        } catch {
          return false;
        } finally {
          if (guard) await guard.close();
        }
      });
    },
    release(home, owner) {
      return serial(async () => {
        const lease = owned.get(home);
        if (!lease || lease.record.owner !== owner) throw ownershipError();
        try {
          const { record } = await readOwner(lease.guard);
          if (JSON.stringify(record) !== JSON.stringify(lease.record))
            throw ownershipError();
          await writeOwner(lease.guard, { ...lease.record, released: true });
        } finally {
          owned.delete(home);
          await lease.guard.close();
        }
      });
    },
    async approveRecovery(home, owner) {
      const text = await serial(async () => {
        approvals.delete(home);
        return withGuard(home, async (guard) => {
          const { text, record } = await readOwner(guard);
          if (
            !record ||
            record.released ||
            record.owner !== owner ||
            !(await terminated(record.identity))
          )
            throw ownershipError();
          return text;
        });
      });
      await approveRecovery(home, owner);
      await serial(async () => {
        approvals.set(home, text);
      });
    },
    recover(home, owner) {
      return serial(async () => {
        const approved = approvals.get(home);
        approvals.delete(home);
        await withGuard(home, async (guard) => {
          const { text, record } = await readOwner(guard);
          if (
            !approved ||
            text !== approved ||
            !record ||
            record.released ||
            record.owner !== owner ||
            !(await terminated(record.identity))
          )
            throw ownershipError();
          await writeOwner(guard, { ...record, released: true });
        });
      });
    },
  };
}

export class CoordinatorOwnership {
  private readonly serial = serialQueue();
  private owned = false;
  private closed = false;
  constructor(
    readonly home: string,
    readonly owner: string,
    private readonly port: OwnershipPort,
  ) {}
  claim(): Promise<"owned" | "held"> {
    return this.serial(async () => {
      if (this.closed) return "held";
      if (this.owned) return "owned";
      try {
        const inspection = await this.port.inspect(this.home);
        if (!inspection.safe || inspection.lock) return "held";
        this.owned = await this.port.acquire(this.home, this.owner);
        return this.owned && !this.closed ? "owned" : "held";
      } catch {
        return "held";
      }
    });
  }
  recover(): Promise<"held"> {
    return this.serial(async (): Promise<"held"> => {
      const before = await this.port.inspect(this.home);
      if (
        this.closed ||
        this.owned ||
        !before.safe ||
        !before.lock ||
        before.lock.running
      )
        throw new Error("Recovery is not eligible");
      await this.port.approveRecovery(this.home, before.lock.owner);
      const after = await this.port.inspect(this.home);
      if (
        this.closed ||
        !after.safe ||
        !after.lock ||
        after.lock.running ||
        after.lock.owner !== before.lock.owner
      )
        throw new Error("Recovery is not eligible");
      await this.port.recover(this.home, before.lock.owner);
      return "held";
    });
  }
  async dispose(drain: () => Promise<void>): Promise<void> {
    this.closed = true;
    await this.serial(async () => {
      await drain();
      if (this.owned) await this.port.release(this.home, this.owner);
      this.owned = false;
    });
  }
}

export interface ObserverRecord {
  coordinatorID: string;
  generation: number;
  verifier: string;
  sequence: number;
}
const serviceHomeKey = Symbol.for("opencode.conman.native-service-home.v1");
type ServiceHome = { home: string; instances: number };
// Symbol.for survives plugin-module reloads within the native service process.
export function registerServiceHome(home: string): () => void {
  const registry = globalThis as typeof globalThis & {
    [serviceHomeKey]?: ServiceHome;
  };
  const existing = registry[serviceHomeKey];
  if (existing && existing.home !== home)
    throw new Error(
      "Conflicting canonical homes in one native service are unsupported",
    );
  const entry = existing ?? { home, instances: 0 };
  registry[serviceHomeKey] = entry;
  entry.instances++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.instances === 0 && registry[serviceHomeKey] === entry)
      delete registry[serviceHomeKey];
  };
}

export interface ObserverPort {
  load(): Promise<ObserverRecord | undefined>;
  save(record: ObserverRecord): Promise<void>;
  approve(record: ObserverRecord): Promise<void>;
}

export interface SignedControl {
  generation: number;
  sequence: number;
  payload: string;
  signature: string;
}

export interface ControlPayload {
  operation: string;
  taskID: string;
  revision: number;
  epoch: number;
  body?: unknown;
}

export function createObserverCapability(): {
  verifier: string;
  sign(
    generation: number,
    sequence: number,
    payload: ControlPayload,
  ): SignedControl;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    verifier: publicKey.export({ format: "pem", type: "spki" }).toString(),
    sign(generation, sequence, payload) {
      const text = JSON.stringify(payload);
      return {
        generation,
        sequence,
        payload: text,
        signature: sign(
          null,
          controlBytes(generation, sequence, text),
          privateKey,
        ).toString("base64"),
      };
    },
  };
}

function controlBytes(
  generation: number,
  sequence: number,
  payload: string,
): Buffer {
  return Buffer.from(JSON.stringify([generation, sequence, payload]));
}

export function forceNativeAsk(event: {
  action: string;
  effect: "allow" | "ask" | "deny";
}): void {
  if (event.action.startsWith("conman.") && event.effect !== "deny")
    event.effect = "ask";
}

export class ObserverAuthority {
  private readonly serial = serialQueue();
  private current: ObserverRecord | undefined;
  private fence = 0;
  constructor(
    readonly coordinatorID: string,
    private readonly port: ObserverPort,
  ) {}
  attach(verifier: string): Promise<number> {
    const fence = this.fence;
    return this.serial(async () => {
      if (
        verifier.length > 512 ||
        createPublicKey(verifier).asymmetricKeyType !== "ed25519"
      )
        throw new Error("Observer authority is not eligible");
      const previous = await this.port.load();
      const generation = (previous?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new Error("Observer authority is not eligible");
      const record = {
        coordinatorID: this.coordinatorID,
        generation,
        verifier,
        sequence: 0,
      };
      await this.port.approve(structuredClone(record));
      if (fence !== this.fence)
        throw new Error("Observer authority is not eligible");
      try {
        await this.port.save(structuredClone(record));
      } catch (error) {
        this.revoke();
        throw error;
      }
      if (fence !== this.fence)
        throw new Error("Observer authority is not eligible");
      this.current = record;
      this.fence++;
      return generation;
    });
  }
  authorize(
    proof: SignedControl,
    expected: Omit<ControlPayload, "body">,
  ): Promise<ControlPayload> {
    return this.serial(async () => {
      const record = this.current;
      const fence = this.fence;
      if (!record) throw new Error("Observer authority is not eligible");
      const payload = validateControl(proof, record, expected);
      const updated = { ...record, sequence: proof.sequence };
      await this.port.save(structuredClone(updated));
      if (fence !== this.fence)
        throw new Error("Observer authority is not eligible");
      this.current = updated;
      return payload;
    });
  }
  revoke(): void {
    this.fence++;
    this.current = undefined;
  }
}

function validateControl(
  proof: SignedControl,
  record: ObserverRecord | undefined,
  expected: Omit<ControlPayload, "body">,
): ControlPayload {
  const fail = () => new Error("Observer authority is not eligible");
  if (
    !record ||
    proof.generation !== record.generation ||
    !Number.isSafeInteger(proof.sequence) ||
    proof.sequence !== record.sequence + 1 ||
    typeof proof.payload !== "string" ||
    proof.payload.length > 16_384 ||
    typeof proof.signature !== "string" ||
    proof.signature.length !== 88
  )
    throw fail();
  try {
    const signature = Buffer.from(proof.signature, "base64");
    if (
      signature.length !== 64 ||
      signature.toString("base64") !== proof.signature ||
      !verify(
        null,
        controlBytes(proof.generation, proof.sequence, proof.payload),
        record.verifier,
        signature,
      )
    )
      throw fail();
    const payload: unknown = JSON.parse(proof.payload);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw fail();
    const value = payload as ControlPayload;
    if (
      value.operation !== expected.operation ||
      value.taskID !== expected.taskID ||
      value.revision !== expected.revision ||
      value.epoch !== expected.epoch
    )
      throw fail();
    return value;
  } catch {
    throw fail();
  }
}
