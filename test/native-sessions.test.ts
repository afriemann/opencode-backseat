import { describe, expect, it } from "bun:test";
import type { OpenCodeClient, SessionInfo } from "@opencode/client";
import {
  readNativeAsks,
  readNativeInventory,
  readNativeSessionDelivery,
  type NativeSessionClient,
} from "../src/native-sessions.ts";
import { diagnosticContext } from "../src/native-connection.ts";

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
    const client: NativeSessionClient & {
      form: Pick<OpenCodeClient["form"], "list">;
    } = {
      form: {
        async list(input) {
          return {
            location: { directory: input!.location!.directory! },
            data: [],
          };
        },
      },
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
      createdAt: 1,
      updatedAt: 1,
      projectID: "one",
      parentID: null,
      topLevel: true,
      archived: false,
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
    f.client.form.list = async (input) => ({
      location: { directory: input!.location!.directory! },
      data:
        input!.location!.directory === "/projects/two"
          ? [
              {
                id: "form",
                sessionID: "two",
                title: "Approval",
                fields: [{ key: "approval", type: "boolean" }],
              },
            ]
          : [],
    });
    expect((await readNativeInventory(f.client)).sessions[1]?.status).toBe(
      "waiting-for-input",
    );
    const form: Awaited<
      ReturnType<NativeSessionClient["session"]["form"]["list"]>
    >[number] = {
      id: "form",
      sessionID: "two",
      title: "Approval",
      fields: [{ key: "approval", type: "boolean" }],
    };
    f.client.session.form.list = async () => [form];
    for (const kind of ["pending", "cancelled", "mismatched"] as const) {
      f.client.session.form.get = async () => ({
        ...form,
        id: kind === "mismatched" ? "other" : form.id,
        state: { status: kind === "cancelled" ? "cancelled" : "pending" },
      });
      const asks = readNativeAsks(f.client, {
        location: "/projects/two",
        workerID: "two",
      });
      if (kind === "mismatched")
        await expect(asks).rejects.toThrow(
          "Form inventory does not match the selected worker",
        );
      else expect(await asks).toEqual(kind === "pending" ? ["form:form"] : []);
    }
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
    for (const phase of ["permissions", "forms"] as const) {
      const degraded = fixture();
      const fail = async () => {
        throw new Error("PRIVATE_ASK_SENTINEL");
      };
      if (phase === "permissions")
        degraded.client.permission.request.list = fail;
      else degraded.client.form.list = fail;
      const records: Record<string, unknown>[] = [];
      const result = await readNativeInventory(
        degraded.client,
        undefined,
        undefined,
        {},
        diagnosticContext((_level, event, fields) => {
          if (event === "refresh.degraded") records.push(fields!);
          throw new Error("Diagnostic sink unavailable");
        }, "inventory"),
      );
      expect(result.sessions.map((row) => row.status)).toEqual([
        "unknown",
        "unknown",
      ]);
      expect(records).toContainEqual(
        expect.objectContaining({ phase, count: 2 }),
      );
      expect(JSON.stringify(records)).not.toContain("PRIVATE_ASK_SENTINEL");
    }
  });

  it("Shares pending form reads within each inventory refresh", async () => {
    const f = fixture();
    while (f.workers.length < 19)
      f.workers.push({ ...f.workers[0]!, id: `worker-${f.workers.length}` });
    const reads: string[] = [];
    let sessionReads = 0;
    let detailReads = 0;
    let pending = true;
    f.client.session.form.list = async () => {
      sessionReads++;
      return [];
    };
    f.client.session.form.get = async () => {
      detailReads++;
      throw new Error("Unexpected form detail read");
    };
    f.client.form.list = async (input) => {
      const directory = input!.location!.directory!;
      reads.push(directory);
      return {
        location: { directory },
        data:
          pending && directory === "/projects/one"
            ? [
                {
                  id: "pending",
                  sessionID: "one",
                  title: "Approval",
                  fields: [{ key: "approval", type: "boolean" }],
                },
              ]
            : [],
      };
    };
    const first = await readNativeInventory(f.client);
    expect(first.sessions[0]?.status).toBe("waiting-for-input");
    expect(
      first.sessions.slice(1).every((row) => row.status === "inactive"),
    ).toBe(true);
    expect(reads.sort()).toEqual(["/projects/one", "/projects/two"]);
    expect(sessionReads).toBe(0);
    expect(detailReads).toBe(0);
    pending = false;
    expect((await readNativeInventory(f.client)).sessions[0]?.status).toBe(
      "inactive",
    );
    expect(reads).toHaveLength(4);
  });

  it.each([
    "unavailable",
    "location",
    "duplicate",
    "identity",
    "owner",
    "shape",
  ])("Reports partial or unknown inventory honestly", async (kind) => {
    const f = fixture();
    while (f.workers.length < 11)
      f.workers.push({ ...f.workers[0]!, id: `worker-${f.workers.length}` });
    let failedReads = 0;
    const list = f.client.form.list;
    f.client.form.list = async (input) => {
      if (input!.location!.directory !== "/projects/one") return list(input);
      failedReads++;
      if (kind === "unavailable") throw new Error("PRIVATE_FORM_SENTINEL");
      const form = {
        id: "form",
        sessionID: "one",
        title: "Approval",
        fields: [{ key: "approval", type: "boolean" }],
      };
      return {
        location: {
          directory: kind === "location" ? "/wrong" : "/projects/one",
        },
        data:
          kind === "duplicate"
            ? [form, form]
            : kind === "identity"
              ? [{ ...form, id: "" }]
              : kind === "owner"
                ? [{ ...form, sessionID: "" }]
                : kind === "shape"
                  ? undefined
                  : [form],
      } as unknown as Awaited<ReturnType<typeof list>>;
    };
    const result = await readNativeInventory(f.client);
    expect(result.sessions.map((row) => row.status)).toEqual(
      f.workers.map((worker) => (worker.id === "two" ? "inactive" : "unknown")),
    );
    expect(result.partial).toBe(true);
    expect(failedReads).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FORM_SENTINEL");
  });
});

describe("Full native session controls", () => {
  it("Reconciles a delivery beyond the first two hundred messages", async () => {
    const page = (start: number, count: number, next?: string) => ({
      data: Array.from({ length: count }, (_, i) => ({
        id: `m${start + i}`,
        type: "user",
      })),
      cursor: next ? { next } : {},
    });
    const client = {
      session: {
        get: async () => ({
          id: "w",
          agent: "engineer",
          location: { directory: "/p" },
        }),
        inbox: { list: async () => [] },
      },
      message: {
        list: async (input: { cursor?: string }) =>
          input.cursor === "c2"
            ? page(400, 200)
            : input.cursor === "c1"
              ? page(200, 200, "c2")
              : page(0, 200, "c1"),
      },
    } as unknown as Parameters<typeof readNativeSessionDelivery>[0];
    const delivery = {
      id: "m450",
      sessionID: "w",
      agent: "engineer",
      location: "/p",
    };
    expect(
      await readNativeSessionDelivery(
        client,
        delivery,
        new AbortController().signal,
      ),
    ).toBe("admitted");
  });
});
