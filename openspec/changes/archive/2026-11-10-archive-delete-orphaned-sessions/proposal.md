# Proposal

## Why

`update_session` (archive) and `delete_session` fail with ENOENT for sessions whose recorded project directory no longer exists, and `delete_session` rejects sessions that have no agent. Stale session batches cannot be cleaned up.

## Product intent

The coordinator user must be able to archive or delete worker sessions whatever the state of their project directory or agent record. Operations stay permission-asserted and pinned to the exact session and recorded location.

## What Changes

- `delete_session` and `update_session` accept a session whose recorded location directory is missing on disk; other location errors and mismatches still reject.
- `delete_session` accepts a session with no agent; `update_session` makes `agent` optional and must match the session's agent (absent for an agent-less session).
- Every other operation, and creation, still require an existing canonical location and the current agent.

## Capabilities

### Modified Capabilities

- `worker-coordination`: requirements "Full native session controls" and "Explicit native subtree deletion".

## Impact

`src/server.ts`, `src/tools.ts`, `src/native-operations.ts`, `src/state.ts`, tests, `openspec/specs/worker-coordination/spec.md`.
