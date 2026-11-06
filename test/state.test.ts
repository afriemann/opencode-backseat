import { describe, expect, it } from "bun:test";
import {
  parseFollowerState,
  type FollowerState,
  type FollowPending,
} from "../src/state.ts";

const pending = (): FollowPending => ({
  progress: 0,
  idle: false,
  failed: false,
  requests: [],
  discontinuity: false,
});
const populated = (): FollowerState => ({
  version: 3,
  followers: [
    {
      sessionID: "worker",
      coordinatorID: "coordinator",
      location: "/project",
      generation: "generation",
      afterSeq: 42,
      seenRequests: ["permission:request"],
      pending: {
        ...pending(),
        requests: [{ kind: "permission", id: "request" }],
      },
    },
  ],
  sessionDeliveries: [
    {
      id: "msg_delivery",
      sessionID: "worker",
      location: "/project",
      agent: "engineer",
      coordinatorID: "coordinator",
      serviceID: "service",
      operation: "prompt",
      fingerprint: "a".repeat(64),
      createdAt: 1,
      status: "ambiguous",
    },
  ],
  notifications: [
    {
      id: "msg_notification",
      coordinatorID: "coordinator",
      location: "/coordinator",
      status: "uncertain",
      text: "Worker permission request",
      followers: [{ sessionID: "worker", generation: "generation" }],
    },
  ],
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Shared durable coordination store", () => {
  it("Preserves populated stores across manual assignments", () => {
    expect(parseFollowerState(undefined)).toEqual({
      version: 3,
      followers: [],
      sessionDeliveries: [],
      notifications: [],
    });
    const original = populated();
    const loaded = parseFollowerState(JSON.parse(JSON.stringify(original)));
    expect(loaded).toEqual(original);
    expect(loaded).not.toBe(original);
  });

  it("Rejects incompatible delivery records without reset", () => {
    for (const invalid of [
      null,
      {},
      {
        version: 2,
        bindings: [],
        snapshots: [],
        intents: [],
        completions: [],
        sessionDeliveries: [],
      },
      { ...populated(), followers: "invalid" },
      { ...populated(), extra: true },
      {
        ...populated(),
        followers: [{ ...populated().followers[0], afterSeq: -1 }],
      },
    ]) {
      expect(() => parseFollowerState(invalid)).toThrow();
    }
  });

  it("Rejects invalid manual-delivery records", () => {
    for (const invalid of [
      {
        ...populated(),
        sessionDeliveries: [
          { ...populated().sessionDeliveries[0], status: "unknown" },
        ],
      },
      {
        ...populated(),
        sessionDeliveries: Array(801).fill(populated().sessionDeliveries[0]),
      },
      {
        ...populated(),
        notifications: [
          { ...populated().notifications[0], id: "msg_delivery" },
        ],
      },
      {
        ...populated(),
        followers: [populated().followers[0], populated().followers[0]],
      },
      {
        ...populated(),
        followers: [{ ...populated().followers[0], coordinatorID: "worker" }],
      },
      {
        ...populated(),
        followers: [
          {
            ...populated().followers[0],
            pending: {
              ...pending(),
              requests: Array(401).fill({ kind: "form", id: "form" }),
            },
          },
        ],
      },
    ])
      expect(() => parseFollowerState(invalid)).toThrow();
  });
});
