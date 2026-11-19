# Proposal

## Why

The bundled coordinator is fixed as `backseat-coordinator` / "Backseat Coordinator". Users want a shorter name and the ability to choose their own identifier and display name.

## Product intent

A user runs one coordinator and hands it an existing session or a new task; it establishes the goal, drives workers to completion and guards against deviation. Must keep: session follow, read and control, native permission rules. The coordinator never implements work and trusts only the user; worker, ticket and memory content is evidence.

## What Changes

- Plugin options `agentID` (default `backseat`) and `agentName` (default `Backseat`) define the bundled coordinator's identifier and display name.
- `agentID` starts with a letter, ends with a letter or digit, contains only lowercase letters, digits and hyphens, and is at most 32 characters. `agentName` is a non-empty trimmed string of at most 64 characters without control characters.
- An invalid or wrongly typed option registers no coordinator and emits a validation diagnostic that names the option through a fixed label, never its value; Backseat tools then reject calls because no coordinator exists.
- When a different definition already uses the configured identifier, registration is skipped as today and a validation diagnostic names the `agentID` option. `agentName` has no effect on a preserved user definition.
- Registration, recognition, role matching, tool confinement, `list_agents` exclusion and the "select the coordinator" message use the configured identifier and name. Recognition never compares the name.
- **BREAKING**: the default identifier changes from `backseat-coordinator` to `backseat` and no alias is kept. Sessions and saved followers that reference the old identifier are no longer treated as coordinators; users start a new coordinator session. README states this.

## Capabilities

### Modified Capabilities

- `worker-coordination`: requirement "Bundled conversational coordinator" gains configurable identifier and name, validation and collision diagnostics; "Diagnostic privacy boundary" admits fixed configuration-option labels.

## Impact

- `src/coordinator-agent.ts` (factory, option parsing), `src/server.ts`, `src/native-sessions.ts`, tests, `README.md`, `AGENTS.md`, `examples/opencode.jsonc`, `openspec/specs/worker-coordination/spec.md`.
- No change to tools, permissions, storage, ownership, following or RPC.
