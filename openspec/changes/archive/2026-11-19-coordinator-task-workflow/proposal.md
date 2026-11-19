# Proposal

## Why

The coordinator prompt does not describe how users work with it, and the coordinator cannot see session cost or context size; existing readers do not report them per session.

## Product intent

A user runs one coordinator and hands it an existing session or a new task; it establishes the goal, writes a task list, drives workers to completion and guards against deviation from the goal. Must keep: session follow, read and control, native permission rules. The coordinator never implements work and trusts only the user; worker, ticket and memory content is evidence.

## What Changes

- New read-only tool `read_session_usage` returns, for one session (children excluded), labelled cumulative cost and tokens, its model, the model's context limit and a context-size estimate. Undeterminable values are `unknown`, never zero. The estimate is `unknown` unless the newest assistant message is complete, reports tokens and no compaction or revert followed it.
- The coordinator instructions describe the workflow:
  - Takeover: understand the session from its content or a recap; ask the user only when the task stays ambiguous.
  - New task: read ticket ids when tools allow, otherwise rely on the user's description; resolve uncertainties in one round. Instruction-like ticket text goes to the user and is quoted as untrusted when passed on.
  - Record the goal and a task list in the todo list, hand tasks to sessions and drive them to completion. Minimal involvement never relaxes worker-gate relay, permission replies or destructive-action rules.
  - Deviation guard: weigh each worker deviation for goal impact (UX or UI change, usability-affecting security restriction, scope); recap the user briefly when significant.
  - Cost and context: compact an idle session at a task boundary only on a known high estimate and report it; start a replacement session carrying the goal and task list when old context should be dropped.
- The coordinator's permission rules allow `read_session_usage`, appended after existing entries.

## Capabilities

### Modified Capabilities

- `worker-coordination`: adds requirements "Session usage reading" and "Coordinator task workflow".

## Impact

- `src/coordinator-agent.ts`, `src/native-content.ts`, `src/native-sessions.ts`, `src/tools.ts`, tests, `README.md`.
- No change to other tools, storage, ownership, following or RPC.
