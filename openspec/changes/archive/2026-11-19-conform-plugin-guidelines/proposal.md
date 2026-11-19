# Proposal

## Product intent

A human runs one coordinator conversation that supervises parallel OpenCode worker sessions and is woken when a worker needs attention. Must keep: idle, failure, permission and form notifications; full native session controls; the coordinator's confinement to coordination tools. Trust model: the user trusts the coordinator model within configured OpenCode permissions; nothing the model receives or inserts may be hidden from the user.

## Why

Issue #38 audits the plugin against the `opencode-plugin-dev` guidelines. Three findings are user-visible defects: idle notifications never fire because the host does not publish `session.idle`; the follower notification and the model's `synthetic` tool can insert model-facing text with no visible row; and the `context` hook repeats live host lookups on every model call.

## What Changes

- Follower notifications carry a non-empty `description`, so the TUI shows a row.
- The `synthetic` coordination tool requires a non-blank `description` (**BREAKING** for callers that omit it).
- Idle detection matches `session.execution.succeeded`.
- The `context` hook decides the coordinator role once per session and reuses it; `execute.before` keeps its live identity check and remains the enforcing gate.
- Diagnostics go through one host emitter (the direct stderr writer is removed); setup logs `version`, `runtime`, host version and resolved configuration; `execute.before` and `context` tool removal emit diagnostics.
- README and AGENTS.md record: tools are Code-Mode-only by design; the coordinator tool-catalog restriction; model-initiated instruction entries are visible tool calls; `location` selects a project and is not a working directory; the Bun and `make coverage` CI shape is deliberate.
- Unchanged after verification: `@opencode/client` in `dependencies`, `effect` peer `^4.0.6`, the `@opencode/plugin/promise/adapter` import, CI workflow, `location` parameter names.

## Capabilities

### Modified Capabilities

- `worker-coordination`: "Background followed-session events" (idle trigger, visible notification row) and "Full native session controls" (`synthetic` requires a description).

## Impact

`src/server.ts`, `src/native-operations.ts`, `src/native-connection.ts` (diagnostic event labels), `test/*.test.ts`, `README.md`, `AGENTS.md`. No dependency, storage or CI change.
