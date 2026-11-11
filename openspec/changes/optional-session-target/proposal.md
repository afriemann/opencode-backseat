# Proposal

## Why

Addressing an existing session requires `sessionID`, `location` and `agent`, but tool descriptions do not state that, and a session whose agent no longer exists cannot be targeted. The session ID already identifies the target and the controller already re-validates it before executing.

## What Changes

- Existing-session tools (`send_session`, the `*_session` sends, session controls other than create and import) require only `sessionID`; `location` and `agent` become optional target assertions.
- A supplied `location` or `agent` that differs from the live session is still rejected.
- Tool descriptions state that only `sessionID` is required.
- Create and import keep `location` and `agent` required.

## Product intent

A coordinator controls many native sessions and should address one by ID. It must still detect a changed target, and it trusts configured native permissions.

## Capabilities

### Modified Capabilities

- `worker-coordination`: "Full native session controls" accepts an existing session by ID alone.

## Impact

`src/tools.ts`, `src/server.ts`, `src/native-operations.ts`, `test/*.test.ts`.
