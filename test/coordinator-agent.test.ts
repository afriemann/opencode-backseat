import { describe, expect, it } from "bun:test";
import { coordinatorAgent } from "../src/coordinator-agent.ts";

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

  it("Denies unrelated actions", () => {
    expect(effectFor("shell")).toBe("deny");
  });
});
