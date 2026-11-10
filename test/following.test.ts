import { describe, expect, it, spyOn } from "bun:test";
import { NativeFollower, type FollowHost } from "../src/server.ts";
import {
  emptyPending,
  type FollowNotification,
  type FollowPending,
} from "../src/state.ts";
import { observeFollowedSession } from "../src/native-content.ts";
import type { OpenCodeClient, SessionLogItem } from "@opencode/client";

function fixture(initial?: unknown) {
  let stored = structuredClone(initial);
  let afterSeq = 10;
  let update = emptyPending();
  let status: "admitted" | "uncertain" = "admitted";
  let proof: "admitted" | "unknown" = "unknown";
  const owner: "gone" | "idle" | "active" = "idle";
  const notifications: FollowNotification[] = [];
  const host: FollowHost = {
    storage: {
      async get() {
        return structuredClone(stored);
      },
      async set(_key, value) {
        stored = structuredClone(value);
      },
    },
    async target(sessionID) {
      return { sessionID, location: `/project/${sessionID}` };
    },
    async ownerState() {
      return owner;
    },
    async observe(_id, after) {
      return {
        afterSeq,
        pending: after === undefined ? emptyPending() : structuredClone(update),
      };
    },
    async notify(notification) {
      notifications.push(structuredClone(notification));
      return status;
    },
    async reconcile() {
      return proof;
    },
  };
  return {
    host,
    notifications,
    stored: () => stored,
    events(pending: Partial<FollowPending>, seq = afterSeq + 1) {
      update = { ...emptyPending(), ...pending };
      afterSeq = seq;
    },
    uncertain() {
      status = "uncertain";
    },
    admitted() {
      proof = "admitted";
      status = "admitted";
    },
  };
}

function timers() {
  const pending: Array<{ run: () => void; delay: number }> = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    run: () => void,
    delay: number,
  ) => {
    pending.push({ run, delay });
    return { unref() {} };
  }) as unknown as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  return {
    pending,
    restore() {
      timer.mockRestore();
      clear.mockRestore();
    },
  };
}

// spec: openspec/specs/worker-coordination/spec.md
describe("Background followed-session events", () => {
  it("Accepts task-free adoption without inventing a binding", async () => {
    const calls: unknown[] = [];
    const events: SessionLogItem[] = [
      {
        id: "large-event",
        created: 1,
        type: "session.execution.succeeded",
        durable: { aggregateID: "worker", seq: 1, version: 1 },
        data: { sessionID: "worker" },
        metadata: { payload: "x".repeat(8_000_001) },
      },
      {
        id: "event",
        created: 1,
        type: "session.execution.succeeded",
        durable: { aggregateID: "worker", seq: 10, version: 1 },
        data: { sessionID: "worker" },
      },
      { type: "log.synced", aggregateID: "worker", seq: 10 },
    ];
    const client = {
      experimental: {
        session: {
          async *log(input: { after: number }) {
            calls.push(input);
            yield* events.filter(
              (event) =>
                event.type === "log.synced" || event.durable.seq > input.after,
            );
          },
        },
      },
      permission: {
        request: {
          async list() {
            return {
              location: { directory: "/project/worker" },
              data: [
                {
                  id: "pending-permission",
                  sessionID: "worker",
                  action: "shell",
                  resources: ["make test"],
                },
              ],
            };
          },
        },
      },
      session: {
        form: {
          async list() {
            return [];
          },
        },
      },
    } as unknown as OpenCodeClient;
    const f = fixture();
    f.host.observe = (_sessionID, after) =>
      observeFollowedSession(
        client,
        "worker",
        "/project/worker",
        after,
        new AbortController().signal,
      );
    const core = await NativeFollower.load(f.host);
    await core.follow("worker", "coordinator");
    expect(core.snapshot().followers[0]!.afterSeq).toBe(10);
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0]!.text).toContain("pending-permission");
    expect(f.notifications[0]!.text).toContain('"progress":0');
    expect(calls).toEqual([{ sessionID: "worker", after: 0, follow: false }]);
    await core.ingest("worker");
    expect(f.notifications).toHaveLength(1);
    events.splice(
      0,
      events.length,
      {
        id: "success",
        created: 2,
        type: "session.execution.succeeded",
        durable: { aggregateID: "worker", seq: 11, version: 1 },
        data: { sessionID: "worker" },
      },
      {
        id: "failed",
        created: 2,
        type: "session.step.failed",
        durable: { aggregateID: "worker", seq: 12, version: 1 },
        data: {
          sessionID: "worker",
          assistantMessageID: "msg_failed",
          error: { type: "failure", message: "failed" },
        },
      },
      {
        id: "revert",
        created: 2,
        type: "session.revert.committed",
        durable: { aggregateID: "worker", seq: 13, version: 1 },
        data: { sessionID: "worker", to: "msg_target" },
      },
      {
        id: "notification",
        created: 2,
        type: "session.execution.succeeded",
        durable: { aggregateID: "worker", seq: 14, version: 1 },
        data: { sessionID: "worker" },
        metadata: { "backseat.notification": true },
      },
      { type: "log.synced", aggregateID: "worker", seq: 14 },
    );
    const replay = await f.host.observe("worker", 10);
    expect(replay).toMatchObject({
      afterSeq: 14,
      pending: { progress: 3, idle: true, failed: true, discontinuity: true },
    });
    events.splice(0, events.length, {
      type: "log.synced",
      aggregateID: "worker",
      seq: 2,
    });
    expect((await f.host.observe("worker", 14)).pending.discontinuity).toBe(
      true,
    );
    events.splice(
      0,
      events.length,
      {
        id: "overflow",
        created: 3,
        type: "session.execution.succeeded",
        durable: { aggregateID: "worker", seq: 15, version: 1 },
        data: { sessionID: "worker" },
        metadata: { payload: "x".repeat(8_000_001) },
      },
      { type: "log.synced", aggregateID: "worker", seq: 15 },
    );
    expect(await f.host.observe("worker", 14)).toMatchObject({
      afterSeq: 15,
      pending: { discontinuity: true },
    });
    await core.dispose();
  });
  it("Delivers actionable events without an initial send", async () => {
    const f = fixture();
    const core = await NativeFollower.load(f.host);
    await core.follow("worker", "coordinator");
    expect(core.snapshot().followers).toHaveLength(1);
    expect(f.notifications).toHaveLength(0);
    f.events({ idle: true, failed: true });
    await core.ingest("worker", {
      requests: [
        { kind: "permission", id: "permission-1" },
        { kind: "form", id: "form-1" },
      ],
    });
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0]!.text).toContain("worker");
    expect(f.notifications[0]!.text).toContain("permission-1");
    expect(f.notifications[0]!.text).toContain("form-1");
    expect(f.notifications[0]!.text).toContain('"idle":true');
    expect(f.notifications[0]!.text).toContain('"failed":true');
    await core.ingest("worker", { idle: true });
    expect(f.notifications).toHaveLength(1);
    await core.dispose();
  });

  it("Coalesces bounded progress without hiding requests", async () => {
    const f = fixture();
    const core = await NativeFollower.load(f.host);
    await core.follow("worker", "coordinator");
    const clock = timers();
    try {
      f.events({ progress: 1 });
      await core.ingest("worker");
      expect(clock.pending[0]!.delay).toBe(500);
      clock.pending.shift()!.run();
      await core.transaction(async () => undefined);
      expect(f.notifications).toHaveLength(1);
      f.notifications.length = 0;
    } finally {
      clock.restore();
    }
    for (let i = 0; i < 10; i++) {
      f.events({ progress: 1 });
      await core.ingest("worker");
    }
    expect(f.notifications).toHaveLength(0);
    await core.ingest("worker", {
      requests: [{ kind: "permission", id: "permission-2" }],
    });
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0]!.text).toContain('"progress":10');
    expect(f.notifications[0]!.text).toContain("permission-2");
    expect(Buffer.byteLength(f.notifications[0]!.text)).toBeLessThanOrEqual(
      16384,
    );
    const requests = Array.from({ length: 400 }, (_, i) => ({
      kind: "form" as const,
      id: `${i}-` + "r".repeat(190),
    }));
    await core.ingest("worker", { requests });
    while (core.snapshot().followers.some((row) => row.pending.requests.length))
      await core.flush("coordinator");
    const delivered = f.notifications
      .slice(1)
      .flatMap(
        (notice) =>
          JSON.parse(
            notice.text.slice(notice.text.indexOf("\n") + 1),
          ) as Array<{ requests: Array<{ id: string }> }>,
      )
      .flatMap((row) => row.requests.map((request) => request.id));
    expect(new Set(delivered)).toEqual(
      new Set(requests.map((request) => request.id)),
    );
    expect(
      f.notifications.every(
        (notice) => Buffer.byteLength(notice.text) <= 16384,
      ),
    ).toBe(true);
    f.host.target = async (sessionID) => ({
      sessionID,
      location: "l".repeat(20000),
    });
    await core.follow("large-location", "coordinator");
    await core.ingest("large-location", { idle: true });
    expect(f.notifications.at(-1)!.text).toContain("large-location");
    expect(Buffer.byteLength(f.notifications.at(-1)!.text)).toBeLessThanOrEqual(
      16384,
    );
    await core.dispose();
  });

  it("Recovers following across reloads", async () => {
    const f = fixture();
    const first = await NativeFollower.load(f.host);
    await first.follow("worker", "coordinator");
    f.uncertain();
    await first.ingest("worker", {
      requests: [{ kind: "form", id: "form-2" }],
    });
    await first.dispose();
    f.host.notify = async (notice) => {
      f.notifications.push(notice);
      return "admitted";
    };
    const second = await NativeFollower.load(f.host);
    await second.reload();
    expect(second.snapshot().followers).toHaveLength(1);
    expect(f.notifications).toHaveLength(2);
    expect(f.notifications[1]!.id).toBe(f.notifications[0]!.id);
    f.admitted();
    f.events({ idle: true });
    await second.ingest("worker");
    expect(f.notifications).toHaveLength(3);
    expect(f.notifications[2]!.id).not.toBe(f.notifications[0]!.id);
    await second.dispose();
    const blocked = fixture(),
      clock = timers();
    const retrying = await NativeFollower.load(blocked.host);
    try {
      blocked.host.notify = async () => {
        throw new Error("Unavailable");
      };
      await retrying.follow("worker", "coordinator");
      await retrying.ingest("worker", { idle: true });
      for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        expect(clock.pending[0]!.delay).toBe(delay);
        clock.pending.shift()!.run();
        await retrying.transaction(async () => undefined);
      }
    } finally {
      await retrying.dispose();
      clock.restore();
    }
  });

  it("Reports observation discontinuity", async () => {
    const f = fixture();
    const core = await NativeFollower.load(f.host);
    await core.follow("worker", "coordinator");
    f.events({ discontinuity: true }, 2);
    await core.ingest("worker");
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0]!.text).toContain('"discontinuity":true');
    expect(core.snapshot().followers[0]!.afterSeq).toBe(2);
    const observe = f.host.observe;
    f.host.observe = async () => {
      throw new Error("Native stream unavailable");
    };
    await core.ingest("worker");
    expect(f.notifications).toHaveLength(2);
    expect(f.notifications[1]!.text).toContain('"discontinuity":true');
    expect(core.snapshot().followers[0]!.afterSeq).toBe(2);
    f.host.observe = observe;
    await core.dispose();
  });
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Explicit following lifecycle", () => {
  it("Stops following without worker effects", async () => {
    const f = fixture();
    const core = await NativeFollower.load(f.host);
    await core.follow("worker", "coordinator");
    f.events({ progress: 1 });
    await core.ingest("worker");
    await core.stop("worker", "coordinator");
    await core.ingest("worker", { idle: true });
    await core.flush("coordinator");
    expect(core.snapshot().followers).toEqual([]);
    expect(f.notifications).toEqual([]);
    await core.dispose();
  });

  it("Prevents notification feedback", async () => {
    const f = fixture();
    const core = await NativeFollower.load(f.host);
    await expect(core.follow("coordinator", "coordinator")).rejects.toThrow();
    await core.follow("worker", "coordinator");
    await expect(core.follow("coordinator", "worker")).rejects.toThrow();
    expect(core.snapshot().followers).toHaveLength(1);
    await core.dispose();
  });
});
