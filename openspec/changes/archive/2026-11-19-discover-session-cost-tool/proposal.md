# Proposal

## Why

`read_session_usage` reports one session's own cost; child sessions are excluded, so the coordinator cannot see what a whole task costs. Another configured tool may report cost across a session tree, but Backseat must not depend on or name any specific one.

## What Changes

- The coordinator's instructions direct it to look for a configured tool that reports session cost including subagent sessions, and to use it only when one exists.
- Without such a tool it reports the session's own cost from `read_session_usage`, states that child sessions are excluded, and never estimates or sums by hand.

## Capabilities

### Modified Capabilities

- `worker-coordination`: requirement 'Coordinator task workflow' gains scenario 'Reports cost across subagent sessions only through an available tool'.

## Impact

- `src/coordinator-agent.ts` system prompt, `README.md`, `test/coordinator-agent.test.ts`.
- No code or package dependency on another plugin; permission list unchanged.
