## Why

`create_session` for a location that is not a native project fails with "Native service connection unavailable or unsupported", which hides the real cause. Every unexpected native operation error is reduced to that text with no diagnostic information.

## What Changes

- An unknown worker location or agent is reported as itself, not as a connection failure.
- A generic native operation failure names the error class (never its message) so the cause category is visible.

## Product intent

Actors: the user and the coordinator agent. Job: create and follow workers across projects. Must keep: session creation and actionable failures. Trust model: the coordinator trusts the user and its own tools; native error messages may embed secrets and stay hidden.

## Impact

`src/server.ts`, `src/native-connection.ts`.
