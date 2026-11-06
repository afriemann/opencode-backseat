import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, stat, type FileHandle } from "node:fs/promises";
import { openAnchoredDirectory } from "./storage.ts";

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
  reason?: OwnershipBlocker;
}

export type OwnershipBlocker =
  | "live-owner"
  | "unverifiable-owner"
  | "unsafe-storage"
  | "host-capability-unavailable";
export type OwnershipAcquisition =
  { acquired: true } | { acquired: false; reason: OwnershipBlocker };

const ownershipReasons: Record<OwnershipBlocker, string> = {
  "live-owner": "Coordination store has a live owner",
  "unverifiable-owner": "Coordination owner identity is unverifiable",
  "unsafe-storage": "Coordination storage is unsafe or unavailable",
  "host-capability-unavailable":
    "Required ownership host capability is unavailable",
};

class HostCapabilityError extends Error {}
class LiveOwnerError extends Error {}

export interface OwnershipPort {
  inspect(dataDir: string): Promise<LockInspection>;
  acquire(
    dataDir: string,
    owner: string,
  ): Promise<boolean | OwnershipAcquisition>;
  release(dataDir: string, owner: string): Promise<void>;
  approveRecovery(dataDir: string, owner: string): Promise<void>;
  recover(dataDir: string, owner: string): Promise<void>;
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

async function ownerStatus(
  identity: ProcessIdentity,
): Promise<"terminated" | "live" | "unverifiable"> {
  const current = await processIdentity();
  // A different host/boot/PID namespace is uncertainty, not termination proof.
  if (
    identity.boot !== current.boot ||
    identity.namespace !== current.namespace
  )
    return "unverifiable";
  try {
    return (await processStart(identity.pid)) !== identity.start
      ? "terminated"
      : "live";
  } catch (error) {
    return hasCode(error, "ENOENT") ? "terminated" : "unverifiable";
  }
}

async function terminated(identity: ProcessIdentity): Promise<boolean> {
  return (await ownerStatus(identity)) === "terminated";
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
  validateWrite?: () => Promise<void>,
): Promise<void> {
  await guard.validate();
  await validateWrite?.();
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

async function kernelGuard(dataDir: string): Promise<KernelGuard | undefined> {
  if (
    process.platform !== "linux" ||
    typeof Bun === "undefined" ||
    Bun.version !== "1.4.4" ||
    !process.getuid ||
    !constants.O_NOFOLLOW ||
    !constants.O_DIRECTORY
  )
    throw new HostCapabilityError();
  const anchor = await openAnchoredDirectory(dataDir);
  let file: FileHandle | undefined;
  const close = async () => {
    try {
      await file?.close();
    } finally {
      await anchor.close();
    }
  };
  try {
    file = await open(
      `${anchor.path}/ownership.lock`,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    const lockedFile = file;
    const validate = async () => {
      try {
        await anchor.validateFile(lockedFile, "ownership.lock");
      } catch {
        throw ownershipError();
      }
    };
    await validate();
    let locked: boolean;
    try {
      locked = await acquireKernelLock(file);
    } catch {
      // Helper errors are capability failures, never process-termination evidence.
      throw new HostCapabilityError();
    }
    if (!locked) {
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
  approveRecovery: (dataDir: string, owner: string) => Promise<void>,
  validateRecovery?: () => Promise<void>,
): OwnershipPort {
  const serial = serialQueue();
  const owned = new Map<
    string,
    { guard: KernelGuard; record: FilesystemOwner }
  >();
  const approvals = new Map<string, string>();
  async function withGuard<T>(
    dataDir: string,
    work: (guard: KernelGuard) => Promise<T>,
  ): Promise<T> {
    const lease = owned.get(dataDir);
    const guard = lease?.guard ?? (await kernelGuard(dataDir));
    if (!guard) throw new LiveOwnerError();
    try {
      return await work(guard);
    } finally {
      if (!lease) await guard.close();
    }
  }
  return {
    inspect(dataDir) {
      return serial(async () => {
        let stage: OwnershipBlocker = "unsafe-storage";
        try {
          return await withGuard(
            dataDir,
            async (guard): Promise<LockInspection> => {
              stage = "unverifiable-owner";
              const { record } = await readOwner(guard);
              const status =
                record && !record.released
                  ? await ownerStatus(record.identity)
                  : undefined;
              return record && !record.released
                ? {
                    safe: true,
                    ...(status === "unverifiable"
                      ? { reason: "unverifiable-owner" as const }
                      : {}),
                    lock: {
                      owner: record.owner,
                      running: status !== "terminated",
                    },
                  }
                : { safe: true };
            },
          );
        } catch (error) {
          // Only fixed classifications cross the filesystem boundary.
          return {
            safe: false,
            reason:
              error instanceof HostCapabilityError
                ? "host-capability-unavailable"
                : error instanceof LiveOwnerError
                  ? "live-owner"
                  : stage,
          };
        }
      });
    },
    acquire(dataDir, owner) {
      return serial(async () => {
        if (!owner || owner.length > 512)
          return { acquired: false, reason: "unsafe-storage" };
        if (owned.has(dataDir))
          return { acquired: false, reason: "live-owner" };
        let guard: KernelGuard | undefined;
        let stage: OwnershipBlocker = "unsafe-storage";
        try {
          guard = await kernelGuard(dataDir);
          if (!guard) return { acquired: false, reason: "live-owner" };
          stage = "unverifiable-owner";
          const { record: prior } = await readOwner(guard);
          if (prior && !prior.released) {
            const status = await ownerStatus(prior.identity);
            if (status !== "terminated")
              return {
                acquired: false,
                reason: status === "live" ? "live-owner" : "unverifiable-owner",
              };
          }
          const record: FilesystemOwner = {
            version: 1,
            owner,
            released: false,
            identity: await processIdentity(),
          };
          stage = "unsafe-storage";
          await writeOwner(guard, record);
          owned.set(dataDir, { guard, record });
          guard = undefined;
          return { acquired: true };
        } catch (error) {
          // Filesystem and process errors may contain private paths or owner text.
          return {
            acquired: false,
            reason:
              error instanceof HostCapabilityError
                ? "host-capability-unavailable"
                : stage,
          };
        } finally {
          if (guard) await guard.close();
        }
      });
    },
    release(dataDir, owner) {
      return serial(async () => {
        const lease = owned.get(dataDir);
        if (!lease || lease.record.owner !== owner) throw ownershipError();
        try {
          const { record } = await readOwner(lease.guard);
          if (JSON.stringify(record) !== JSON.stringify(lease.record))
            throw ownershipError();
          await writeOwner(lease.guard, { ...lease.record, released: true });
        } finally {
          owned.delete(dataDir);
          await lease.guard.close();
        }
      });
    },
    async approveRecovery(dataDir, owner) {
      const text = await serial(async () => {
        approvals.delete(dataDir);
        return withGuard(dataDir, async (guard) => {
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
      await approveRecovery(dataDir, owner);
      await serial(async () => {
        approvals.set(dataDir, text);
      });
    },
    recover(dataDir, owner) {
      return serial(async () => {
        const approved = approvals.get(dataDir);
        approvals.delete(dataDir);
        await withGuard(dataDir, async (guard) => {
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
          await writeOwner(
            guard,
            { ...record, released: true },
            validateRecovery,
          );
        });
      });
    },
  };
}

export class CoordinatorOwnership {
  private readonly serial = serialQueue();
  private owned = false;
  private closed = false;
  private blocker: OwnershipBlocker = "unsafe-storage";
  get reason(): string {
    return ownershipReasons[this.blocker];
  }
  constructor(
    readonly dataDir: string,
    readonly owner: string,
    private readonly port: OwnershipPort,
  ) {}
  claim(): Promise<"owned" | "held"> {
    return this.serial(async () => {
      this.blocker = "unsafe-storage";
      if (this.closed) return "held";
      if (this.owned) return "owned";
      try {
        const inspection = await this.port.inspect(this.dataDir);
        if (!inspection.safe || inspection.lock?.running) {
          this.blocker =
            inspection.reason ??
            (inspection.lock ? "live-owner" : "unsafe-storage");
          return "held";
        }
        const acquired = await this.port.acquire(this.dataDir, this.owner);
        this.owned =
          typeof acquired === "boolean" ? acquired : acquired.acquired;
        if (typeof acquired !== "boolean" && !acquired.acquired)
          this.blocker = acquired.reason;
        return this.owned && !this.closed ? "owned" : "held";
      } catch {
        this.blocker = "unsafe-storage";
        return "held";
      }
    });
  }
  recover(): Promise<"held"> {
    return this.serial(async (): Promise<"held"> => {
      const before = await this.port.inspect(this.dataDir);
      if (
        this.closed ||
        this.owned ||
        !before.safe ||
        !before.lock ||
        before.lock.running
      )
        throw new Error("Recovery is not eligible");
      await this.port.approveRecovery(this.dataDir, before.lock.owner);
      const after = await this.port.inspect(this.dataDir);
      if (
        this.closed ||
        !after.safe ||
        !after.lock ||
        after.lock.running ||
        after.lock.owner !== before.lock.owner
      )
        throw new Error("Recovery is not eligible");
      await this.port.recover(this.dataDir, before.lock.owner);
      return "held";
    });
  }
  async dispose(drain: () => Promise<void>): Promise<void> {
    this.closed = true;
    await this.serial(async () => {
      await drain();
      if (this.owned) await this.port.release(this.dataDir, this.owner);
      this.owned = false;
    });
  }
}

export interface ObserverScope {
  dataDir: string;
  coordinatorLocation: string;
}
export interface ObserverRecord extends ObserverScope {
  coordinatorID: string;
  generation: number;
  verifier: string;
  sequence: number;
}

export interface CoordinatorCoreLease<T> {
  readonly core: T;
  release(): Promise<void>;
}

type DisposableCore = { dispose(): Promise<void> };
type CoreRegistry = {
  tail: Promise<unknown>;
  entry?: {
    directory: string;
    core: DisposableCore;
    leases: number;
    closing: boolean;
  };
};
const coordinatorCoreKey = Symbol.for("opencode.backseat.coordinator-core");

export async function acquireCoordinatorCore<
  T extends { dispose(): Promise<void> },
>(
  directory: string,
  create: () => Promise<T>,
): Promise<CoordinatorCoreLease<T>> {
  const service = globalThis as typeof globalThis & {
    [coordinatorCoreKey]?: CoreRegistry;
  };
  const registry = (service[coordinatorCoreKey] ??= {
    tail: Promise.resolve(),
  });
  const serial = <R>(work: () => Promise<R>): Promise<R> => {
    const result = registry.tail.then(work);
    registry.tail = result.catch(() => undefined);
    return result;
  };
  return serial(async () => {
    let entry = registry.entry;
    if (entry && entry.directory !== directory)
      throw new Error("Conflicting coordination stores in one native service");
    if (entry?.closing)
      throw new Error("Coordination runtime shutdown is incomplete; held");
    if (!entry) {
      entry = { directory, core: await create(), leases: 0, closing: false };
      registry.entry = entry;
    }
    const current = entry;
    current.leases++;
    let release: Promise<void> | undefined;
    return {
      core: current.core as T,
      release() {
        return (release ??= serial(async () => {
          if (--current.leases !== 0) return;
          current.closing = true;
          await current.core.dispose();
          if (registry.entry === current) delete registry.entry;
        }));
      },
    };
  });
}

export function forceNativeAsk(event: {
  action: string;
  effect: "allow" | "ask" | "deny";
}): void {
  if (event.action.startsWith("backseat.") && event.effect !== "deny")
    event.effect = "ask";
}
