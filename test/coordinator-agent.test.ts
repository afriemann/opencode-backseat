import { describe, expect, it } from "bun:test";
import {
  coordinatorAgent,
  isCoordinatorAgent,
} from "../src/coordinator-agent.ts";

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
      expect(isCoordinatorAgent(inherited)).toBe(true);
    }
    expect(
      isCoordinatorAgent({ ...coordinatorAgent, system: "unrelated" }),
    ).toBe(false);
  });
});
