import { describe, expect, it, spyOn } from "bun:test";
import * as filesystem from "node:fs/promises";
import * as subprocess from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  openSharedStorage,
  openAnchoredDirectory,
  resolveDataDirectory,
} from "../src/storage.ts";
import {
  CoordinatorOwnership,
  acquireCoordinatorCore,
  createFilesystemOwnershipPort,
} from "../src/ownership.ts";

async function fixture(prefix: string): Promise<string> {
  const root = resolve(".opencode/backseat");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(`${root}/${prefix}-`);
}
function authority(home: string, owner: string): CoordinatorOwnership {
  return new CoordinatorOwnership(home, owner, createFilesystemOwnershipPort());
}
async function child(
  home: string,
  owner: string,
  crash = false,
): Promise<string> {
  const source = new URL("../src/ownership.ts", import.meta.url).href;
  const code = `import {CoordinatorOwnership,createFilesystemOwnershipPort} from ${JSON.stringify(source)}; const a=new CoordinatorOwnership(${JSON.stringify(home)},${JSON.stringify(owner)},createFilesystemOwnershipPort()); console.log(await a.claim()); ${crash ? "process.exit(0)" : "await a.dispose(async()=>{})"};`;
  const process = Bun.spawn([Bun.which("bun")!, "-e", code], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(process.stdout).text(),
    error = await new Response(process.stderr).text();
  expect(await process.exited, error).toBe(0);
  return output.trim();
}

// spec: openspec/specs/worker-coordination/spec.md
describe("Shared durable coordination store", () => {
  it("Shares an XDG-backed store across projects", async () => {
    for (const XDG_DATA_HOME of [undefined, "", "relative"])
      expect(
        resolveDataDirectory(
          {},
          {
            home: "/users/example",
            ...(XDG_DATA_HOME === undefined ? {} : { XDG_DATA_HOME }),
          },
        ),
      ).toBe("/users/example/.local/share/opencode-backseat");
    expect(
      resolveDataDirectory(
        {},
        { home: "/users/example", XDG_DATA_HOME: "/data" },
      ),
    ).toBe("/data/opencode-backseat");
    expect(
      resolveDataDirectory(
        { dataDir: "/custom/store" },
        { home: "/users/example" },
      ),
    ).toBe("/custom/store");
    for (const dataDir of ["", "relative/store"])
      expect(() =>
        resolveDataDirectory({ dataDir }, { home: "/users/example" }),
      ).toThrow("absolute");
    const home = await fixture("shared-store"),
      directory = resolveDataDirectory({}, { home, XDG_DATA_HOME: home });
    try {
      const first = await openSharedStorage(directory);
      await first.set("delivery", {
        location: "/projects/one",
        uncertain: true,
      });
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(`${directory}/state.json`)).mode & 0o777).toBe(0o600);
      await first.close();
      const second = await openSharedStorage(directory);
      try {
        expect(await second.get("delivery")).toEqual({
          location: "/projects/one",
          uncertain: true,
        });
      } finally {
        await second.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("Supports trusted writable storage ancestry", async () => {
    const home = await fixture("writable-ancestry");
    try {
      for (const mode of [0o775, 0o2775, 0o1777]) {
        const parent = `${home}/${mode}`;
        await mkdir(parent);
        await chmod(parent, mode);
        const directory = `${parent}/store`,
          storage = await openSharedStorage(directory);
        await storage.set("delivery", { uncertain: true });
        await storage.close();
        const reopened = await openSharedStorage(directory);
        try {
          expect(await reopened.get("delivery")).toEqual({ uncertain: true });
        } finally {
          await reopened.close();
        }
        const first = authority(directory, "owner"),
          second = authority(directory, "contender");
        try {
          expect(await first.claim()).toBe("owned");
          expect(await second.claim()).toBe("held");
        } finally {
          await second.dispose(async () => {});
          await first.dispose(async () => {});
        }
        expect((await stat(parent)).mode & 0o7777).toBe(mode);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("Holds unsafe or corrupt shared storage", async () => {
    const home = await fixture("unsafe-store");
    try {
      for (const mode of [0o777, 0o757]) {
        const parent = `${home}/public-${mode}`;
        await mkdir(parent);
        await chmod(parent, mode);
        await expect(openSharedStorage(`${parent}/store`)).rejects.toThrow();
      }
      const original = `${home}/original`;
      await mkdir(original, { mode: 0o700 });
      const anchor = await openAnchoredDirectory(`${original}/store`);
      try {
        await rename(original, `${home}/moved`);
        await mkdir(original);
        await mkdir(`${original}/store`, { mode: 0o700 });
        await expect(anchor.validate()).rejects.toThrow();
      } finally {
        await anchor.close();
      }
      for (const failure of [
        "corrupt",
        "missing",
        "symlink",
        "hardlink",
        "mode",
        "directory",
      ]) {
        const directory = `${home}/${failure}`,
          storage = await openSharedStorage(directory);
        await storage.set("delivery", { uncertain: true });
        await storage.close();
        const file = `${directory}/state.json`;
        if (failure === "corrupt") await writeFile(file, "{broken");
        if (failure === "missing" || failure === "symlink") await rm(file);
        if (failure === "symlink") {
          await writeFile(`${home}/target`, "unchanged");
          await symlink(`${home}/target`, file);
        }
        if (failure === "hardlink") await link(file, `${home}/linked-state`);
        if (failure === "mode") await chmod(file, 0o644);
        if (failure === "directory") await chmod(directory, 0o755);
        await expect(openSharedStorage(directory)).rejects.toThrow();
        if (failure === "symlink")
          expect(await readFile(`${home}/target`, "utf8")).toBe("unchanged");
      }
      const nativeOpen = filesystem.open;
      const opened = spyOn(filesystem, "open").mockImplementation(
        async (...args) => {
          const file = await nativeOpen(...args);
          if (
            (await file.stat()).isDirectory() &&
            (await filesystem.realpath(`/proc/self/fd/${file.fd}`)) === home
          )
            spyOn(file, "sync").mockRejectedValue(
              new Error("Parent directory synchronization failed"),
            );
          return file;
        },
      );
      try {
        await expect(openSharedStorage(`${home}/parent-sync`)).rejects.toThrow(
          "Parent directory synchronization failed",
        );
      } finally {
        opened.mockRestore();
      }
      for (const [index, value] of [
        "a".repeat(32 * 1024 * 1024),
        { invalid: undefined },
        { number: Number.NaN },
        Array.from({ length: 80 }).reduce<unknown>((value) => [value], null),
      ].entries()) {
        const storage = await openSharedStorage(`${home}/bounded-${index}`);
        try {
          await expect(storage.set("oversized", value)).rejects.toThrow();
        } finally {
          await storage.close();
        }
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("Recovers from an interrupted publication", async () => {
    const home = await fixture("interrupted");
    try {
      const storage = await openSharedStorage(home);
      await storage.set("delivery", { uncertain: true });
      await storage.close();
      await writeFile(`${home}/.publish-interrupted`, "unfinished", {
        mode: 0o600,
      });
      const reopened = await openSharedStorage(home);
      try {
        expect(await reopened.get("delivery")).toEqual({ uncertain: true });
      } finally {
        await reopened.close();
      }
      expect(await readdir(home)).not.toContain(".publish-interrupted");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("Holds on an unexpected store entry", async () => {
    const home = await fixture("unexpected");
    try {
      await (await openSharedStorage(home)).close();
      await writeFile(`${home}/.publish-linked`, "unfinished", { mode: 0o600 });
      await link(`${home}/.publish-linked`, `${home}/.publish-second-link`);
      await writeFile(`${home}/stray`, "data", { mode: 0o600 });
      await expect(openSharedStorage(home)).rejects.toThrow();
      await rm(`${home}/stray`);
      await expect(openSharedStorage(home)).rejects.toThrow();
      expect(await readdir(home)).toContain(".publish-linked");
      await rm(`${home}/.publish-second-link`);
      await rm(`${home}/.publish-linked`);
      await writeFile(`${home}/.publish-open`, "x", { mode: 0o644 });
      await expect(openSharedStorage(home)).rejects.toThrow();
      expect(await readdir(home)).toContain(".publish-open");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("Removes its temporary file when publication fails", async () => {
    const home = await fixture("publish-failure");
    try {
      const storage = await openSharedStorage(home);
      const renamed = spyOn(filesystem, "rename").mockRejectedValue(
        new Error("rename failed"),
      );
      try {
        await expect(
          storage.set("delivery", { uncertain: true }),
        ).rejects.toThrow("rename failed");
      } finally {
        renamed.mockRestore();
        await storage.close();
      }
      expect(
        (await readdir(home)).filter((name) => name.startsWith(".publish-")),
      ).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Exclusive coordinator authority", () => {
  it("Revalidates terminated ownership under exclusive acquisition", async () => {
    const home = await fixture("kernel"),
      first = authority(home, "first");
    try {
      expect(await first.claim()).toBe("owned");
      const lock = `${home}/ownership.lock`,
        inode = (await stat(lock)).ino;
      expect(await child(home, "independent")).toBe("held");
      const competing = authority(home, "competing");
      expect(await competing.claim()).toBe("held");
      expect(competing.reason).toBe("Coordination store has a live owner");
      await competing.dispose(async () => {});
      await expect(
        first.dispose(async () => {
          throw new Error("Drain failed");
        }),
      ).rejects.toThrow("Drain failed");
      expect(await child(home, "after-drain-failure")).toBe("held");
      await first.dispose(async () => {
        expect(await child(home, "during-drain")).toBe("held");
      });
      expect(await child(home, "after-close")).toBe("owned");
      expect((await stat(lock)).ino).toBe(inode);
      for (const unsafe of [
        "symlink",
        "mode",
        "malformed",
        "invalid-utf8",
        "oversized",
        "lock-mode",
        "lock-symlink",
        "hardlink",
      ]) {
        const target = await fixture("blocked"),
          blocked = authority(target, "blocked");
        try {
          if (unsafe === "symlink") {
            await rm(target, { recursive: true });
            await symlink(home, target);
          } else {
            if (unsafe === "mode") await chmod(target, 0o777);
            if (unsafe === "malformed")
              await writeFile(`${target}/ownership.lock`, "not-json", {
                mode: 0o600,
              });
            if (unsafe === "invalid-utf8") {
              const record = {
                ...JSON.parse(await readFile(lock, "utf8")),
                owner: "invalid-marker",
              };
              const bytes = Buffer.from(JSON.stringify(record));
              bytes[bytes.indexOf("invalid-marker")] = 0xff;
              await writeFile(`${target}/ownership.lock`, bytes, {
                mode: 0o600,
              });
            }
            if (unsafe === "oversized")
              await writeFile(`${target}/ownership.lock`, " ".repeat(8193), {
                mode: 0o600,
              });
            if (unsafe === "lock-mode")
              await writeFile(`${target}/ownership.lock`, "", { mode: 0o644 });
            if (unsafe === "lock-symlink")
              await symlink(lock, `${target}/ownership.lock`);
            if (unsafe === "hardlink")
              await link(lock, `${target}/ownership.lock`);
          }
          expect(await blocked.claim(), unsafe).toBe("held");
        } finally {
          await blocked.dispose(async () => {});
          await rm(target, { recursive: true, force: true });
        }
      }
      const helperHome = await fixture("helper");
      try {
        for (const failure of ["error", "exit"]) {
          const spawn = spyOn(subprocess, "spawn").mockImplementation((() => {
            const helper = new subprocess.ChildProcess();
            queueMicrotask(() => {
              if (failure === "error")
                helper.emit("error", new Error("Helper unavailable"));
              helper.emit("close", 2);
            });
            return helper;
          }) as typeof subprocess.spawn);
          try {
            const unavailable = authority(helperHome, `helper-${failure}`);
            expect(await unavailable.claim()).toBe("held");
            expect(unavailable.reason).toBe(
              "Required ownership host capability is unavailable",
            );
          } finally {
            spawn.mockRestore();
          }
        }
      } finally {
        await rm(helperHome, { recursive: true, force: true });
      }
    } finally {
      await first.dispose(async () => {});
      await rm(home, { recursive: true, force: true });
    }
  });
  it("Reacquires terminated ownership without arming supervision", async () => {
    const home = await fixture("reacquire");
    try {
      expect(await child(home, "terminated", true)).toBe("owned");
      const next = authority(home, "next");
      try {
        expect(await next.claim()).toBe("owned");
        expect(await child(home, "contender")).toBe("held");
      } finally {
        await next.dispose(async () => {});
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("Fences an unloaded project without releasing other participants", async () => {
    const home = await fixture("service-core");
    let created = 0,
      disposed = 0;
    const create = async () => {
      created++;
      return {
        dispose: async () => {
          disposed++;
        },
      };
    };
    try {
      const first = await acquireCoordinatorCore(home, create),
        second = await acquireCoordinatorCore(home, create);
      expect(first.core).toBe(second.core);
      expect(created).toBe(1);
      await expect(
        acquireCoordinatorCore(`${home}/other`, create),
      ).rejects.toThrow("Conflicting");
      await first.release();
      expect(disposed).toBe(0);
      await second.release();
      expect(disposed).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
