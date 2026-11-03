import { describe, expect, it } from "bun:test";
import type { SessionInfo } from "@opencode/client";
import {
  readNativeInventory,
  type NativeSessionClient,
} from "../src/native-sessions.ts";

// spec: openspec/specs/worker-coordination/spec.md
describe("Native session inventory", () => {
  function fixture() {
    const workers: SessionInfo[] = ["one", "two"].map((id) => ({
      id,
      title: id,
      projectID: id,
      agent: "engineer",
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      location: { directory: `/projects/${id}` },
      time: { created: 1, updated: 1, idle: 1 },
      metadata: { private: "not inventory" },
    }));
    let active: Record<string, { type: "running" }> = {};
    let failed = false;
    const requests: unknown[] = [];
    const client: NativeSessionClient = {
      session: {
        async list(input) {
          requests.push(input);
          if (failed) throw new Error("Unavailable");
          return { data: workers, cursor: { next: "next-page" } };
        },
        async get({ sessionID }) {
          return workers.find((w) => w.id === sessionID)!;
        },
        async active() {
          if (failed) throw new Error("Unavailable");
          return active;
        },
        form: {
          async list() {
            return [];
          },
          async get() {
            throw new Error("Unexpected form");
          },
        },
        inbox: {
          async list() {
            return [];
          },
        },
      },
      permission: {
        request: {
          async list(input) {
            return {
              location: { directory: input!.location!.directory! },
              data: [],
            };
          },
        },
      },
    };
    return {
      client,
      workers,
      requests,
      running() {
        active = { one: { type: "running" } };
      },
      fail() {
        failed = true;
      },
    };
  }

  it("Lists sessions across projects without task or TUI prerequisites", async () => {
    const f = fixture();
    f.workers.push({ ...f.workers[0]!, id: "three" });
    let activeReads = 0;
    let permissionReads = 0;
    const permissions = f.client.permission.request.list;
    f.client.permission.request.list = async (...input) => {
      permissionReads++;
      return permissions(...input);
    };
    const active = f.client.session.active;
    f.client.session.active = async (...input) => {
      activeReads++;
      return active(...input);
    };
    const inventory = await readNativeInventory(f.client);
    expect(inventory.available).toBe(true);
    expect(inventory.sessions.map((s) => s.location)).toEqual([
      "/projects/one",
      "/projects/two",
      "/projects/one",
    ]);
    expect(f.requests[0]).not.toHaveProperty("directory");
    expect(activeReads).toBe(2);
    expect(permissionReads).toBe(2);
    expect(inventory.sessions[0]).toEqual({
      id: "one",
      title: "one",
      location: "/projects/one",
      agent: "engineer",
      status: "inactive",
    });
    const bounded = fixture();
    while (bounded.workers.length < 19)
      bounded.workers.push({
        ...bounded.workers[0]!,
        id: `worker-${bounded.workers.length}`,
      });
    let current = 0,
      peak = 0;
    const get = bounded.client.session.get;
    bounded.client.session.get = async (...input) => {
      peak = Math.max(peak, ++current);
      try {
        await Promise.resolve();
        return await get(...input);
      } finally {
        current--;
      }
    };
    expect((await readNativeInventory(bounded.client)).sessions).toHaveLength(
      19,
    );
    expect(peak).toBe(8);
  });

  it("Reports native running and waiting status without automation evidence", async () => {
    const f = fixture();
    f.running();
    const permissions = f.client.permission.request.list;
    f.client.permission.request.list = async (input) => ({
      ...(await permissions(input)),
      data: [
        {
          id: "ask",
          sessionID: "two",
          action: "shell",
          resources: ["private input"],
        },
      ],
    });
    const inventory = await readNativeInventory(f.client);
    expect(inventory.sessions.map((s) => s.status)).toEqual([
      "running",
      "waiting-for-input",
    ]);
    expect(JSON.stringify(inventory)).not.toContain("private input");
    f.client.permission.request.list = permissions;
    f.client.session.form.list = async ({ sessionID }) =>
      sessionID === "two"
        ? [
            {
              id: "form",
              sessionID,
              title: "Approval",
              fields: [{ key: "approval", type: "boolean" }],
            },
          ]
        : [];
    f.client.session.form.get = async ({ sessionID, formID }) => ({
      id: formID,
      sessionID,
      title: "Approval",
      fields: [{ key: "approval", type: "boolean" }],
      state: { status: "pending" },
    });
    expect((await readNativeInventory(f.client)).sessions[1]?.status).toBe(
      "waiting-for-input",
    );
  });

  it("Reports partial or unknown inventory honestly", async () => {
    const f = fixture();
    const page = await readNativeInventory(f.client, "first-page");
    expect(page).toMatchObject({
      available: true,
      partial: true,
      cursor: "next-page",
    });
    expect(f.requests[0]).toHaveProperty("cursor", "first-page");
    for (const kind of ["conflict", "inbox", "duplicate"] as const) {
      const conflicting = fixture();
      if (kind === "conflict") {
        let reads = 0;
        conflicting.client.session.active = async () =>
          ++reads === 1 ? {} : { one: { type: "running" } };
      }
      if (kind === "inbox")
        conflicting.client.session.inbox.list = async ({ sessionID }) =>
          [{ id: "queued", sessionID, type: "user" }] as Awaited<
            ReturnType<NativeSessionClient["session"]["inbox"]["list"]>
          >;
      if (kind === "duplicate")
        conflicting.workers.push(conflicting.workers[0]!);
      const result = await readNativeInventory(conflicting.client);
      expect(result.partial).toBe(true);
      if (kind === "duplicate") expect(result.available).toBe(false);
      else expect(result.sessions[0]?.status).toBe("unknown");
    }
    f.client.session.active = async () => {
      throw new Error("Unavailable");
    };
    expect(
      (await readNativeInventory(f.client)).sessions.map((s) => s.status),
    ).toEqual(["unknown", "unknown"]);
    f.fail();
    expect(await readNativeInventory(f.client)).toMatchObject({
      available: false,
      partial: true,
      reason: expect.any(String),
    });
  });
});
