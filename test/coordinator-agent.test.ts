import { describe, expect, it } from "bun:test";
import { createCoordinator } from "../src/coordinator-agent.ts";

const created = createCoordinator({});
if (!created.ok) throw new Error("default coordinator must be valid");
const { definition: coordinatorAgent, isCoordinator } = created.coordinator;

const matches = (pattern: string, value: string) =>
  new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  ).test(value);

const effectFor = (action: string) =>
  coordinatorAgent.permissions.findLast((rule) => matches(rule.action, action))
    ?.effect;

// spec: openspec/specs/worker-coordination/spec.md
describe("Bundled conversational coordinator", () => {
  it.each([
    "backseat.adopt",
    "backseat.delete",
    "backseat.send_session",
    "backseat.stop_following",
  ])("Allows Backseat operations by default: %s", (action) => {
    expect(effectFor(action)).toBe("allow");
  });

  it("Uses default identifier and name", () => {
    expect(coordinatorAgent.id).toBe("backseat");
    expect(coordinatorAgent.name).toBe("Backseat");
  });

  it("Registers a configured identifier and name", () => {
    const result = createCoordinator({
      agentID: "lead",
      agentName: "Team Lead",
    });
    if (!result.ok) throw new Error("options must be valid");
    const { definition, isCoordinator: recognises } = result.coordinator;
    expect(definition.id).toBe("lead");
    expect(definition.name).toBe("Team Lead");
    expect(recognises(definition)).toBe(true);
    expect(recognises({ ...definition, id: "backseat" })).toBe(false);
    expect(isCoordinator(definition)).toBe(false);
  });

  it("Preserves a configured coordinator agent: recognition ignores the display name", () => {
    const renamed = { ...coordinatorAgent, name: "Renamed" };
    expect(isCoordinator(renamed)).toBe(true);
  });

  it.each([
    ["uppercase", "Lead"],
    ["leading digit", "1lead"],
    ["leading hyphen", "-lead"],
    ["trailing hyphen", "lead-"],
    ["underscore", "lead_one"],
    ["empty", ""],
    ["too long", "a".repeat(33)],
    ["not a string", 7],
  ])("Rejects invalid coordinator options: agentID %s", (_title, agentID) => {
    expect(createCoordinator({ agentID })).toEqual({
      ok: false,
      option: "agentID",
    });
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["untrimmed", " Lead"],
    ["control character", "Le\nad"],
    ["too long", "a".repeat(65)],
    ["not a string", null],
  ])(
    "Rejects invalid coordinator options: agentName %s",
    (_title, agentName) => {
      expect(createCoordinator({ agentName })).toEqual({
        ok: false,
        option: "agentName",
      });
    },
  );

  it("Accepts boundary option values", () => {
    expect(
      createCoordinator({ agentID: "a".repeat(32), agentName: "n".repeat(64) })
        .ok,
    ).toBe(true);
    expect(createCoordinator({ agentID: "a1-b2" }).ok).toBe(true);
  });
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Conversational manual assignment", () => {
  it("Coordinator preserves worker lifecycle", () => {
    expect(coordinatorAgent.system).toContain(
      "Workers run their own configured instructions and lifecycle.",
    );
    expect(coordinatorAgent.system).toContain(
      "never prescribe, shorten, waive or override how the worker does its work",
    );
    expect(coordinatorAgent.system).toContain(
      "relay it to the user instead of answering on their behalf, unless the user delegated that decision",
    );
  });
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Restricted conversational coordination", () => {
  it("Asks for unmatched coordination tool actions", () => {
    for (const action of [
      "tickets_lookup",
      "recall_search",
      "custom_coordination",
    ])
      expect(effectFor(action)).toBe("ask");
    for (const action of [
      "execute",
      "question",
      "todowrite",
      "todoread",
      "backseat_send_session",
    ])
      expect(effectFor(action)).toBe("allow");
    for (const action of [
      "shell",
      "bash",
      "edit",
      "write",
      "patch",
      "read",
      "glob",
      "grep",
      "webfetch",
      "subagent",
      "skill",
      "lsp_find_symbol",
      "use_workdir",
    ])
      expect(effectFor(action)).toBe("deny");
    for (const effect of ["allow", "ask", "deny"] as const) {
      const inherited = {
        ...coordinatorAgent,
        permissions: [
          ...coordinatorAgent.permissions,
          { action: "tickets_*", resource: "*", effect },
        ],
      };
      expect(isCoordinator(inherited)).toBe(true);
    }
    expect(isCoordinator({ ...coordinatorAgent, system: "unrelated" })).toBe(
      false,
    );
  });
});

// spec: openspec/specs/worker-coordination/spec.md
describe("Coordinator task workflow", () => {
  it("Allows usage reading by default", () => {
    expect(effectFor("backseat_read_session_usage")).toBe("allow");
    const inherited = [
      ...coordinatorAgent.permissions,
      {
        action: "backseat_read_session_usage",
        resource: "*",
        effect: "ask" as const,
      },
    ];
    expect(
      inherited.findLast((rule) =>
        matches(rule.action, "backseat_read_session_usage"),
      )?.effect,
    ).toBe("ask");
    expect(isCoordinator({ ...coordinatorAgent, permissions: inherited })).toBe(
      true,
    );
  });

  it.each([
    ["Takes over an existing session", "Takeover of an existing session"],
    ["Takes over an existing session", "recap_session"],
    ["Starts a new task", "look them up and read them for context"],
    ["Starts a new task", "quoted, untrusted ticket content"],
    ["Drives a task list to completion", "task list in the todo list"],
    ["Drives a task list to completion", "Minimal involvement never relaxes"],
    ["Guards against goal deviation", "weigh its impact"],
    ["Takes over an existing session", "only if the task stays ambiguous"],
    ["Starts a new task", "in one round"],
    ["Drives a task list to completion", "destructive actions need the user"],
    ["Manages context and cost", "at least 70% of a known contextLimit"],
    ["Manages context and cost", "report the compaction afterwards"],
    ["Manages context and cost", "read_session_usage"],
    ["Manages context and cost", "replacement session"],
  ])("%s: instructs %s", (_scenario, phrase) => {
    expect(coordinatorAgent.system).toContain(phrase);
  });
});
