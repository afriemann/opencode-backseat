# Proposal

## Product intent

Actors: a user driving the coordinator, which supervises worker sessions. Job: get a quick gist of a long session without paging its transcript. Must keep: recap and generation of large sessions, and the short deadline that surfaces a dead native service. Trust model: the coordinator is trusted to recap any session its permissions allow.

## Why

`recap_session` fails with "Native service read timed out" on large sessions because its LLM generation shares the fixed 10-second native read deadline, so every retry fails the same way.

## What Changes

- LLM-backed operations (`recap_session`, `generate_session`) get a 120-second deadline for the operation itself.
- The 10-second deadline still covers the service handshake and every other operation.

## Capabilities

### Modified Capabilities

- `worker-coordination`: requirement "Session recap" states that a recap may run longer than the default read deadline.

## Impact

`src/native-connection.ts`, `src/native-operations.ts`, `src/server.ts`; tests in `test/native-connection.test.ts` and `test/session-control.test.ts`; one README line.
