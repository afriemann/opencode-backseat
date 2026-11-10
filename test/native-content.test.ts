import { describe, expect, it } from "bun:test";
import type {
  OpenCodeClient,
  SessionInfo,
  SessionEventDurable,
  SessionMessageAssistant,
} from "@opencode/client";
import { createNativeContent } from "../src/native-content.ts";

function fixture(budget?: number) {
  const session: SessionInfo = {
    id: "worker",
    projectID: "project",
    agent: "engineer",
    location: { directory: "/projects/worker" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  };
  let time = 0;
  const calls: unknown[] = [];
  const messages = [
    {
      id: "message-1",
      type: "assistant",
      content: [{ type: "text", text: "Selected response" }],
    },
  ];
  let data: unknown = messages;
  const client = {
    session: {
      get: async () => session,
      context: async () => data,
      message: { get: async () => data },
    },
    message: {
      list: async (input: { cursor?: string }) => {
        calls.push(input);
        return {
          data: input.cursor
            ? [
                {
                  id: "message-2",
                  type: "idle",
                  outcome: "succeeded",
                  time: { created: 2 },
                },
              ]
            : messages,
          cursor: input.cursor ? {} : { next: "native-next" },
        };
      },
    },
  } as unknown as OpenCodeClient;
  return {
    session,
    client,
    calls,
    content: createNativeContent(() => time, budget),
    query: {
      sessionID: "worker",
      location: "/projects/worker",
      agent: "engineer",
      limit: 1,
      maxBytes: 1024,
      order: "asc" as const,
    },
    signal: new AbortController().signal,
    setData(value: unknown) {
      data = value;
    },
    advance() {
      time = 2 * 60 * 60_000;
    },
  };
}

// spec: openspec/specs/worker-coordination/spec.md
describe("Native session content pagination", () => {
  it("Pages selected session content incrementally", async () => {
    const f = fixture();
    const first = await f.content.read(
      "messages",
      f.query,
      "caller",
      "service",
      f.client,
      f.signal,
    );
    expect(first.available).toBe(true);
    expect(first.data).toMatchObject([{ id: "message-1" }]);
    const second = await f.content.read(
      "messages",
      { ...f.query, cursor: first.cursor },
      "caller",
      "service",
      f.client,
      f.signal,
    );
    expect(second).toMatchObject({
      available: true,
      data: [{ id: "message-2" }],
    });
    expect(second.cursor).toBeUndefined();
    expect(f.calls).toEqual([
      { sessionID: "worker", limit: 1, order: "asc" },
      { sessionID: "worker", limit: 1, cursor: "native-next" },
    ]);
    const large = [
      {
        id: "large-message",
        content: [{ type: "text", text: '😀\n"'.repeat(800) }],
      },
    ];
    f.setData(large);
    let cursor: string | undefined,
      reconstructed = "";
    do {
      const page = await f.content.read(
        "context",
        { ...f.query, ...(cursor ? { cursor } : {}) },
        "caller",
        "service",
        f.client,
        f.signal,
      );
      expect(page.encoding).toBe("json-text");
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        f.query.maxBytes,
      );
      reconstructed += page.chunk;
      cursor = page.cursor;
    } while (cursor);
    expect(JSON.parse(reconstructed)).toEqual(large);
    f.content.dispose();
    for (const kind of [
      "message",
      "diff",
      "inbox",
      "permissions",
      "permission",
      "saved_permissions",
      "forms",
      "form",
      "instructions",
      "stats",
      "export",
    ] as const) {
      const selected = fixture();
      const received: unknown[] = [];
      const projection = { id: "selected", sessionID: "worker" };
      const capture = async (input: unknown) => {
        received.push(input);
        return projection;
      };
      const client = {
        session: {
          get: selected.client.session.get,
          message: { get: capture },
          diff: capture,
          inbox: { list: capture },
          form: { list: capture, get: capture },
        },
        permission: { list: capture, get: capture, saved: { list: capture } },
        experimental: {
          session: {
            instructions: { entry: { list: capture } },
            stats: capture,
            export: capture,
          },
        },
      } as unknown as OpenCodeClient;
      const extra =
        kind === "message"
          ? { messageID: "selected" }
          : kind === "permission"
            ? { requestID: "selected" }
            : kind === "form"
              ? { formID: "selected" }
              : kind === "diff"
                ? { from: "first", to: "last", context: 2 }
                : kind === "stats"
                  ? {
                      statsFrom: 1,
                      statsTo: 2,
                      timezone: "UTC",
                      toolsLevel: "summary" as const,
                    }
                  : {};
      const result = await selected.content.read(
        kind,
        { ...selected.query, ...extra },
        "caller",
        "service",
        client,
        selected.signal,
      );
      expect(result.data).toEqual(projection);
      const expected =
        kind === "saved_permissions"
          ? { projectID: "project" }
          : kind === "stats"
            ? {
                project: "project",
                from: 1,
                to: 2,
                timezone: "UTC",
                tools: "summary",
              }
            : kind === "export"
              ? { sessionID: "worker", sanitize: false }
              : { sessionID: "worker", ...extra };
      expect(received).toEqual([expected]);
      selected.content.dispose();
    }
  });
  it("Reads content larger than eight megabytes in consistent chunks", async () => {
    const f = fixture();
    const original = [{ text: "x".repeat(9_000_000) }];
    f.setData(original);
    const query = { ...f.query, maxBytes: 64_000 };
    let page = await f.content.read(
      "context",
      query,
      "caller",
      "service",
      f.client,
      f.signal,
    );
    let joined = "";
    for (let i = 0; page.chunk !== undefined; i++) {
      joined += page.chunk;
      if (i === 0) f.setData([{ text: "changed" }]);
      if (!page.cursor) break;
      page = await f.content.read(
        "context",
        { ...query, cursor: page.cursor },
        "caller",
        "service",
        f.client,
        f.signal,
      );
    }
    expect(joined).toBe(JSON.stringify(original));
  });
  it("Reports snapshot capacity exhaustion", async () => {
    const f = fixture(1000);
    f.setData([{ text: "large".repeat(1000) }]);
    await expect(
      f.content.read(
        "context",
        f.query,
        "caller",
        "service",
        f.client,
        f.signal,
      ),
    ).rejects.toThrow("snapshot_capacity");
  });
  it("Rejects invalid or unavailable content continuation", async () => {
    for (const change of [
      "caller",
      "service",
      "query",
      "target",
      "expired",
      "unknown",
      "disposed",
    ] as const) {
      const f = fixture();
      const first = await f.content.read(
        "messages",
        f.query,
        "caller",
        "service",
        f.client,
        f.signal,
      );
      if (change === "target") f.session.location.directory = "/projects/moved";
      if (change === "expired") f.advance();
      if (change === "disposed") f.content.dispose();
      await expect(
        f.content.read(
          "messages",
          {
            ...f.query,
            limit: change === "query" ? 2 : 1,
            cursor: change === "unknown" ? "unknown" : first.cursor,
          },
          change === "caller" ? "other" : "caller",
          change === "service" ? "other" : "service",
          f.client,
          f.signal,
        ),
      ).rejects.toThrow();
      f.content.dispose();
    }
    for (const kind of ["permission", "form"] as const) {
      for (const changed of ["id", "sessionID"] as const) {
        const selected = fixture();
        const get = async () => ({
          id: changed === "id" ? "other" : "selected",
          sessionID: changed === "sessionID" ? "other" : "worker",
        });
        const client = {
          session: { get: selected.client.session.get, form: { get } },
          permission: { get },
        } as unknown as OpenCodeClient;
        await expect(
          selected.content.read(
            kind,
            {
              ...selected.query,
              ...(kind === "permission"
                ? { requestID: "selected" }
                : { formID: "selected" }),
            },
            "caller",
            "service",
            client,
            selected.signal,
          ),
        ).rejects.toThrow("target changed");
        selected.content.dispose();
      }
    }
  });
});

function trackingFixture() {
  const f = fixture();
  const events: SessionEventDurable[] = [];
  const after: number[] = [];
  const message: SessionMessageAssistant = {
    id: "reply",
    type: "assistant",
    agent: "engineer",
    model: { id: "model", providerID: "provider" },
    time: { created: 3 },
    content: [{ type: "text", text: "partial" }],
  };
  f.client.session.message.get = async () => structuredClone(message);
  f.client.session.inbox = {
    list: async () => [],
  } as unknown as OpenCodeClient["session"]["inbox"];
  f.client.experimental = {
    session: {
      async *log(input: { after?: number }) {
        after.push(input.after ?? 0);
        for (const event of events)
          if (event.durable.seq > (input.after ?? 0)) yield event;
        yield {
          type: "log.synced",
          aggregateID: "worker",
          seq: events.at(-1)?.durable.seq ?? 0,
        };
      },
    },
  } as unknown as OpenCodeClient["experimental"];
  function delivered(seq: number, inboxID: string) {
    events.push({
      id: `event-${seq}`,
      created: seq,
      type: "session.inbox.delivered",
      durable: { aggregateID: "worker", seq, version: 1 },
      data: { sessionID: "worker", inboxID },
    });
  }
  function started(seq: number) {
    events.push({
      id: `event-${seq}`,
      created: seq,
      type: "session.step.started",
      durable: { aggregateID: "worker", seq, version: 1 },
      data: {
        sessionID: "worker",
        assistantMessageID: "reply",
        agent: "engineer",
        model: message.model,
        started: seq,
      },
    });
  }
  const query = {
    sessionID: "worker",
    location: "/projects/worker",
    agent: "engineer",
    sendID: "msg_sent",
    limit: 2,
    maxBytes: 2048,
  };
  return { ...f, events, after, message, delivered, started, query };
}

// spec: openspec/specs/worker-coordination/spec.md
describe("Since-send response tracking", () => {
  it("Follows activity from an admitted send", async () => {
    const f = trackingFixture();
    f.delivered(1, "earlier");
    f.delivered(2, "msg_sent");
    f.started(3);
    const first = await f.content.follow(
      f.query,
      "caller",
      "service",
      f.client,
      f.signal,
    );
    expect(first.anchor).toBe("delivered");
    expect(first.afterSeq).toBe(2);
    expect(first.events.map((event) => event.seq)).toEqual([2]);
    const second = await f.content.follow(
      { ...f.query, cursor: first.cursor },
      "caller",
      "service",
      f.client,
      f.signal,
    );
    expect(second.updates[0]?.message).toEqual(f.message);
    expect(second.attribution).toBe("uncertain");
    f.message.content = [
      { type: "text", text: "partial with new streaming text" },
    ];
    const third = await f.content.follow(
      { ...f.query, cursor: second.cursor },
      "caller",
      "service",
      f.client,
      f.signal,
    );
    expect(third.updates[0]?.message).toEqual(f.message);
    expect(third.updates[0]?.replace).toBe(true);
    expect(f.after).toEqual([0, 2, 3]);
    expect(f.calls).toEqual([]);
    f.delivered(4, "concurrent-user-input");
    const fourth = await f.content.follow(
      { ...f.query, cursor: third.cursor },
      "caller",
      "service",
      f.client,
      f.signal,
    );
    expect(fourth.interleaved).toBe(true);
    expect(fourth.attribution).toBe("uncertain");
    expect(fourth.updates).toEqual([]);
    f.message.content = [
      { type: "text", text: "A larger evolving response\n".repeat(400) },
    ];
    let cursor = fourth.cursor,
      text = "",
      more = true;
    while (more) {
      const page = await f.content.follow(
        { ...f.query, cursor },
        "caller",
        "service",
        f.client,
        f.signal,
      );
      expect(page.available).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        f.query.maxBytes,
      );
      text += page.updates[0]?.chunk ?? "";
      cursor = page.cursor;
      more = page.more;
    }
    expect(JSON.parse(text)).toEqual(f.message);
    f.content.dispose();
    const alreadyRunning = trackingFixture();
    alreadyRunning.started(1);
    alreadyRunning.delivered(2, "msg_sent");
    const active = await alreadyRunning.content.follow(
      alreadyRunning.query,
      "caller",
      "service",
      alreadyRunning.client,
      alreadyRunning.signal,
    );
    expect(active.updates[0]?.message).toEqual(alreadyRunning.message);
    alreadyRunning.message.content = [
      { type: "text", text: "Ongoing work changed after delivery" },
    ];
    const updated = await alreadyRunning.content.follow(
      { ...alreadyRunning.query, cursor: active.cursor },
      "caller",
      "service",
      alreadyRunning.client,
      alreadyRunning.signal,
    );
    expect(updated.updates[0]?.message).toEqual(alreadyRunning.message);
    expect(updated.attribution).toBe("uncertain");
    alreadyRunning.content.dispose();
  });
  it("Reports tracking discontinuity honestly", async () => {
    for (const change of [
      "anchor",
      "revert",
      "caller",
      "service",
      "target",
      "expired",
      "native",
      "sync-regression",
      "no-sync",
      "compaction",
      "sequence",
    ] as const) {
      const f = trackingFixture();
      if (change !== "anchor") f.delivered(1, "msg_sent");
      const first = await f.content.follow(
        f.query,
        "caller",
        "service",
        f.client,
        f.signal,
      );
      if (change === "anchor") {
        expect(first.status).toBe("discontinuity");
        expect(first.reason ?? "").toContain("anchor");
        f.content.dispose();
        continue;
      }
      if (change === "revert")
        f.events.push({
          id: "reverted",
          created: 2,
          type: "session.revert.cleared",
          durable: { aggregateID: "worker", seq: 2, version: 1 },
          data: { sessionID: "worker" },
        });
      if (change === "target") f.session.location.directory = "/projects/moved";
      if (
        change === "sync-regression" ||
        change === "no-sync" ||
        change === "sequence" ||
        change === "compaction"
      ) {
        f.client.experimental.session.log = async function* () {
          if (change === "compaction")
            yield {
              id: "compacted",
              created: 2,
              type: "session.compaction.started",
              durable: { aggregateID: "worker", seq: 2, version: 1 },
              data: { sessionID: "worker", reason: "manual" },
            } satisfies SessionEventDurable;
          if (change === "sequence") yield f.events[0]!;
          if (change !== "no-sync")
            yield {
              type: "log.synced",
              aggregateID: "worker",
              seq: change === "sync-regression" ? 0 : 2,
            };
        };
      }
      if (change === "expired") f.advance();
      if (change === "native")
        f.client.session.get = async () => {
          throw new Error("Private host response");
        };
      const next = await f.content.follow(
        { ...f.query, cursor: first.cursor },
        change === "caller" ? "other" : "caller",
        change === "service" ? "other" : "service",
        f.client,
        f.signal,
      );
      expect(next.available).toBe(false);
      expect(next.status).toBe("discontinuity");
      expect(next.cursor).toBeUndefined();
      expect(JSON.stringify(next)).not.toContain("Private host response");
      f.content.dispose();
    }
    const queued = trackingFixture();
    queued.client.session.inbox.list = async () => [
      {
        id: "msg_sent",
        type: "user",
        sessionID: "worker",
        time: { created: 1 },
        delivery: "queue",
        payload: { text: "waiting" },
      },
    ];
    const waiting = await queued.content.follow(
      queued.query,
      "caller",
      "service",
      queued.client,
      queued.signal,
    );
    expect(waiting.available).toBe(true);
    expect(waiting.anchor).toBe("pending");
    queued.delivered(1, "msg_sent");
    const delivered = await queued.content.follow(
      { ...queued.query, cursor: waiting.cursor },
      "caller",
      "service",
      queued.client,
      queued.signal,
    );
    expect(delivered.anchor).toBe("delivered");
    queued.content.dispose();
  });
});
